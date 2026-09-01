import { chromium, webkit } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const baseUrl = (process.argv[2] || 'http://127.0.0.1:8088').replace(/\/$/, '');
const outDir = process.argv[3] || '/out';
const viewports = {
  mobile: { width: 412, height: 915, isMobile: true, hasTouch: true },
  tablet: { width: 1024, height: 768, isMobile: false, hasTouch: true },
  desktop: { width: 1600, height: 1000, isMobile: false, hasTouch: false },
  wide: { width: 2560, height: 1440, isMobile: false, hasTouch: false },
  sales619: { width: 619, height: 915, isMobile: true, hasTouch: true },
  sales620: { width: 620, height: 915, isMobile: true, hasTouch: true },
  sales621: { width: 621, height: 915, isMobile: true, hasTouch: true },
  sales639: { width: 639, height: 915, isMobile: true, hasTouch: true },
  sales640: { width: 640, height: 915, isMobile: true, hasTouch: true },
  sales641: { width: 641, height: 915, isMobile: true, hasTouch: true },
};
const wait = (page, selector) => page.locator(selector).first().waitFor({ state: 'visible', timeout: 5000 });

async function assertWorkspaceLandmarks(page, names) {
  const missing = await page.evaluate(expected => {
    const available = new Set(
      [...document.querySelectorAll('[data-dpp-qa]')].map(element => element.getAttribute('data-dpp-qa')),
    );
    return expected.filter(name => !available.has(name));
  }, names);
  if (missing.length) throw new Error(`Missing workspace landmarks: ${missing.join(', ')}`);
}

async function verifyCompactLead(page, firstSurfaceSelector) {
  const state = await page.evaluate(selector => {
    const lead = document.querySelector('.page-lead');
    const firstSurface = document.querySelector(selector);
    const leadRect = lead?.getBoundingClientRect();
    return {
      mobile: window.innerWidth <= 480,
      leadCount: document.querySelectorAll('.page-lead').length,
      titleCount: lead?.querySelectorAll('h1').length || 0,
      firstSurfaceTop: firstSurface?.getBoundingClientRect().top ?? null,
      evidenceOpen: lead?.querySelectorAll('.page-lead__evidence[open]').length || 0,
      contained: Boolean(leadRect && leadRect.left >= -2 && leadRect.right <= window.innerWidth + 2),
    };
  }, firstSurfaceSelector);
  if (
    state.leadCount !== 1 ||
    state.titleCount !== 1 ||
    state.evidenceOpen ||
    !state.contained ||
    (state.mobile && (state.firstSurfaceTop === null || state.firstSurfaceTop > 760))
  ) {
    throw new Error(`Compact page-lead contract mismatch: ${JSON.stringify(state)}`);
  }
}

async function verifyControlTrustAppearance(page, expectedProfile) {
  await wait(page, 'main');
  const state = await page.evaluate(profileId => {
    const root = document.documentElement;
    const css = getComputedStyle(root);
    const visible = node => node.getClientRects().length > 0 && !node.closest('.sr-only');
    const surfaces = [...document.querySelectorAll(
      '.admin-login,.product-editor,.ads-quality,.ads-action-card,.health-summary,.incident,.domain-summary,.source,.bridge-step,.pending-row,.history-row'
    )].filter(visible);
    const channelMax = color => {
      const channels = String(color).match(/[\d.]+/g)?.slice(0, 3).map(Number) || [];
      return channels.length ? Math.max(...channels) : 0;
    };
    const controls = [...document.querySelectorAll('main button,main input,main select,main summary')].filter(visible);
    const expectedLabels = {
      '/': 'Today', '/business': 'Business', '/sales': 'Sales', '/catalog': 'Products',
      '/product': 'Products', '/inventory': 'Inventory', '/finance': 'Finance',
      '/ads': 'Advertising', '/trajectory': 'Trajectory', '/data-health': 'Data Health',
      '/admin': 'Admin',
    };
    const expectedLabel = expectedLabels[location.pathname] || 'Today';
    const colorLuminance = value => {
      const source = String(value).trim();
      const shorthand = source.startsWith('#') && [4, 5].includes(source.length);
      const hex = shorthand
        ? source.slice(1, 4).split('').map(channel => channel + channel)
        : source.slice(1, 7).match(/../g);
      const channels = source.startsWith('#')
        ? (hex || []).map(channel => Number.parseInt(channel, 16) / 255)
        : (source.match(/[\d.]+/g) || []).slice(0, 3).map(channel => Number(channel) / 255);
      if (channels.length !== 3 || channels.some(channel => !Number.isFinite(channel))) return null;
      const linear = channels.map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    };
    const contrast = (first, second) => {
      const a = colorLuminance(first);
      const b = colorLuminance(second);
      if (a === null || b === null) return 0;
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    const token = name => css.getPropertyValue(name).trim();
    const nonTextPairs = [
      ['--dpp-focus-ring', '--dpp-page'], ['--dpp-focus-ring', '--dpp-surface'],
      ['--dpp-border-strong', '--dpp-page'], ['--dpp-border-strong', '--dpp-surface'],
      ['--dpp-data-incomplete', '--dpp-surface'],
      ...['--dpp-data1', '--dpp-data2', '--dpp-data3', '--dpp-data4', '--dpp-data5', '--dpp-data6']
        .map(name => [name, '--dpp-surface']),
    ];
    const nonTextContrastRatios = nonTextPairs.map(([foreground, background]) => ({
      pair: `${foreground}/${background}`,
      ratio: Number(contrast(token(foreground), token(background)).toFixed(2)),
    }));
    const renderedChartChecks = [...document.querySelectorAll(
      '.dpp-chart .dpp-bar,.dpp-chart .dpp-line,.dpp-chart .dpp-dot,.dpp-chart .dpp-bubble,.dpp-chart .dpp-quadrant-line,.dpp-chart .dpp-axis path,.dpp-chart .dpp-axis line'
    )].filter(visible).map(node => {
      const style = getComputedStyle(node);
      const stroke = style.stroke !== 'none' && Number.parseFloat(style.strokeWidth) > 0 ? style.stroke : '';
      const color = stroke || (style.fill !== 'none' ? style.fill : '');
      return {
        element: `${node.tagName.toLowerCase()}.${[...node.classList].join('.')}`,
        ratio: Number(contrast(color, token('--dpp-surface')).toFixed(2)),
      };
    }).filter(item => Number.isFinite(item.ratio));
    const footer = document.querySelector('.app > footer.footer');
    const footerDetails = footer?.querySelector('.footer-diagnostics');
    const footerSummary = footerDetails?.querySelector(':scope > summary');
    const footerRect = footer?.getBoundingClientRect();
    const footerSummaryRect = footerSummary?.getBoundingClientRect();
    return {
      theme: root.getAttribute('data-dpp-theme'),
      profile: root.getAttribute('data-dpp-profile'),
      colorScheme: css.colorScheme,
      expectedColorScheme: ['midnight-dark', 'aubergine-dark', 'weyland'].includes(profileId) ? 'dark' : 'light',
      semanticTokens: [
        '--dpp-surface','--dpp-surface-subtle','--dpp-text','--dpp-text-muted','--dpp-border','--dpp-interaction','--dpp-focus-ring','--dpp-data1','--dpp-data2','--dpp-data-incomplete','--dpp-healthy-surface','--dpp-warning-surface','--dpp-critical-surface'
      ].every(token => css.getPropertyValue(token).trim()),
      darkSurfaces:
        !['midnight-dark', 'aubergine-dark', 'weyland'].includes(profileId) ||
        surfaces.every(node => channelMax(getComputedStyle(node).backgroundColor) < 180),
      controlFloor: controls.every(node => node.getBoundingClientRect().height >= 40),
      metadataFloor: Number.parseFloat(css.getPropertyValue('--dpp-metadata-size')) >= 14,
      weylandType:
        profileId !== 'weyland' ||
        (!/mono|courier/i.test(getComputedStyle(document.body).fontFamily) &&
          /mono|courier/i.test(css.getPropertyValue('--dpp-font-display')) &&
          /mono|courier/i.test(css.getPropertyValue('--dpp-font-detail'))),
      weylandMobileTexture:
        profileId !== 'weyland' ||
        window.innerWidth > 640 ||
        css.getPropertyValue('--dpp-panel-texture').trim() === 'none',
      contained: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2,
      nonTextContrastFloor: nonTextContrastRatios.every(item => item.ratio >= 3),
      nonTextContrastRatios,
      renderedChartContrastFloor: renderedChartChecks.every(item => item.ratio >= 3),
      renderedChartChecks,
      shellIdentity:
        document.querySelector('.nav-primary-set a.active .domain-link__label')?.textContent?.trim() === expectedLabel &&
        document.querySelector('.shell-header-context__title')?.textContent?.trim() === expectedLabel,
      pageTitle: document.title === `Dirty Pawz Press · ${expectedLabel}`,
      footerContract:
        document.querySelectorAll('footer.footer').length === 1 &&
        footer?.getAttribute('aria-label') === 'Build diagnostics' &&
        footerDetails &&
        !footerDetails.open &&
        footerSummary?.textContent?.trim() === 'Build info' &&
        footer.innerText.replace(/\s+/g, ' ').trim() === 'Build info' &&
        footerSummaryRect?.height >= 40 &&
        footerRect?.left >= -2 &&
        footerRect?.right <= window.innerWidth + 2 &&
        getComputedStyle(footer).textTransform === 'none',
    };
  }, expectedProfile);
  if (
    state.theme !== expectedProfile ||
    state.colorScheme !== state.expectedColorScheme ||
    !state.semanticTokens ||
    !state.darkSurfaces ||
    !state.controlFloor ||
    !state.metadataFloor ||
    !state.weylandType ||
    !state.weylandMobileTexture ||
    !state.contained ||
    !state.nonTextContrastFloor ||
    !state.renderedChartContrastFloor ||
    !state.shellIdentity ||
    !state.pageTitle ||
    !state.footerContract ||
    (expectedProfile === 'weyland' && state.profile !== 'weyland')
  ) {
    throw new Error(`Control/trust ${expectedProfile} appearance mismatch: ${JSON.stringify(state)}`);
  }
}

async function verifyAdmin(page) {
  await wait(page, '#loginPanel');
  const state = await page.evaluate(() => {
    const visible = node => node.getClientRects().length > 0 && !node.closest('.sr-only');
    const evidence = [...document.querySelectorAll('.admin-shell .kicker,.admin-shell .page-header__description,.admin-eyebrow,.admin-login p,.admin-status')].filter(visible);
    const controls = [...document.querySelectorAll('#loginPanel input,#loginPanel button')].filter(visible);
    return {
      evidenceFloor: evidence.every(node => Number.parseFloat(getComputedStyle(node).fontSize) >= 14),
      controlFloor: controls.every(node => node.getBoundingClientRect().height >= 40),
    };
  });
  if (!state.evidenceFloor || !state.controlFloor) {
    throw new Error(`Admin login presentation mismatch: ${JSON.stringify(state)}`);
  }
}

async function verifyAds(page, view = 'overview') {
  await assertWorkspaceLandmarks(page, ['ads-workspace-header', 'ads-operating-evidence']);
  await verifyCompactLead(page, '[data-dpp-qa="ads-overview"]');
  const navigation = await page.evaluate(() => {
    const tabs = document.querySelector('.ads-page .subnav');
    return {
      mobile: window.innerWidth <= 640,
      pageOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      tabCount: tabs?.querySelectorAll('.subnav__item').length || 0,
      containedOverflow: Boolean(tabs && tabs.scrollWidth >= tabs.clientWidth),
    };
  });
  if (
    navigation.mobile &&
    (navigation.pageOverflow > 1 || navigation.tabCount !== 5 || !navigation.containedOverflow)
  ) {
    throw new Error(`Ads mobile navigation mismatch: ${JSON.stringify(navigation)}`);
  }
  const payload = await page.evaluate(async () => (await (await fetch('/api/ads', { cache: 'no-store' })).json()));
  if (payload.connection?.state !== 'READY' || payload.status !== 'ready') {
    await wait(page, '#emptyState');
    const disconnected = await page.evaluate(connectionDetail => {
      const tabs = [...document.querySelectorAll('[data-ads-view]')];
      const note = document.getElementById('adsViewAvailability');
      return {
        overviewEnabled: tabs[0]?.dataset.adsView === 'overview' && !tabs[0].disabled,
        drillsDisabled: tabs.slice(1).every(tab => tab.disabled && tab.getAttribute('aria-disabled') === 'true'),
        explained: Boolean(
          note && !note.hidden &&
          note.textContent.trim() === 'Only Overview is available in the current Advertising connection state.' &&
          !note.textContent.includes(connectionDetail || 'missing connection detail')
        ),
        singleDetailOwner:
          document.querySelector('#emptyState p')?.textContent?.trim() === connectionDetail,
        contained: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2,
      };
    }, payload.connection?.detail || '');
    if (!disconnected.overviewEnabled || !disconnected.drillsDisabled || !disconnected.explained || !disconnected.singleDetailOwner || !disconnected.contained) {
      throw new Error(`Ads disconnected-state presentation mismatch: ${JSON.stringify(disconnected)}`);
    }
    return;
  }
  if (view === 'campaigns') {
    await page.locator('button[data-ads-view="campaigns"]').click();
    await wait(page, '#campaignQuadrant .dpp-bubble');
  } else {
    await wait(page, '#chart .dpp-bar');
  }
  const state = await page.evaluate(apiActions => {
    const visible = element => element && element.getClientRects().length > 0;
    const tabs = document.querySelector('.ads-page .subnav');
    const tabsRect = tabs?.getBoundingClientRect();
    const evidence = [...document.querySelectorAll(
      '.ads-page .kicker,.ads-page .page-header__description,.ads-page .section-header__description,.ads-page .kpi__label,.ads-page .kpi__note,.ads-page .data-table th,.ads-page .data-table td,.ads-quality p,.ads-action-body p'
    )].filter(visible);
    const controls = [...document.querySelectorAll('.ads-page .subnav__item,.ads-action-open')].filter(visible);
    const reasons = [...document.querySelectorAll('#actionQueue .ads-action-body p')].map(node => node.textContent.trim());
    return {
      tabsEnabled: [...document.querySelectorAll('[data-ads-view]')].every(tab => !tab.disabled && tab.getAttribute('aria-disabled') === 'false'),
      tabsContained:
        Boolean(tabsRect && tabsRect.left >= -2 && tabsRect.right <= window.innerWidth + 2) &&
        document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2,
      evidenceFloor: evidence.every(node => Number.parseFloat(getComputedStyle(node).fontSize) >= 14),
      controlFloor: controls.every(node => node.getBoundingClientRect().height >= 40),
      apiReasons: JSON.stringify(reasons) === JSON.stringify(apiActions.map(action => String(action.reason || ''))),
      browserActionCells: document.querySelectorAll('#targetRows .ads-action,#searchTermRows .ads-action').length,
    };
  }, payload.actions || []);
  if (!state.tabsEnabled || !state.tabsContained || !state.evidenceFloor || !state.controlFloor || !state.apiReasons || state.browserActionCells) {
    throw new Error(`Ads evidence/control presentation mismatch: ${JSON.stringify(state)}`);
  }
}

async function verifySalesOverview(page) {
  await wait(page, '#monthChart .dpp-bar');
  await verifyCompactLead(page, '.sales-chart-card');
  for (const [range, selector] of [['90d', '.sales-week'], ['28d', '.sales-day'], ['full', '.sales-month']]) {
    await page.locator(`button[data-range="${range}"]`).click();
    await wait(page, `#monthChart ${selector}`);
  }
  await page.locator('button[data-range="12m"]').click();
  const state = await page.evaluate(() => {
    const mobile = window.innerWidth <= 720;
    const signals = document.querySelector('.sales-state-rail');
    const chart = document.querySelector('.sales-main');
    const reference = document.getElementById('salesReference');
    const primary = document.querySelector('.sales-signal.primary');
    const today = document.querySelector('.sales-utility-today');
    const ruleTrigger = [...document.querySelectorAll('.sales-page .rule-trigger')]
      .find(element => element.getClientRects().length > 0);
    const todayLink = document.querySelector('.sales-utility-today .btn');
    const kpiRail = document.querySelector('.sales-chart-kpi-rail');
    const chartCard = document.querySelector('.sales-chart-card');
    const kpiRect = kpiRail?.getBoundingClientRect();
    const cardRect = chartCard?.getBoundingClientRect();
    return {
      mobile,
      chartBeforeSignals: Boolean(
        signals && chart && chart.getBoundingClientRect().top < signals.getBoundingClientRect().top
      ),
      referenceOpen: Boolean(reference?.hasAttribute('open')),
      primaryVisible: Boolean(primary && primary.getBoundingClientRect().height > 0),
      todayVisible: Boolean(today && today.getBoundingClientRect().height > 0),
      ruleTriggerHeight: ruleTrigger?.getBoundingClientRect().height || 0,
      ruleTriggerFont: Number.parseFloat(ruleTrigger ? getComputedStyle(ruleTrigger).fontSize : '0'),
      todayLinkHeight: todayLink?.getBoundingClientRect().height || 0,
      todayLinkFont: Number.parseFloat(todayLink ? getComputedStyle(todayLink).fontSize : '0'),
      railAligned: Boolean(
        kpiRect && cardRect &&
        Math.abs(kpiRect.left - cardRect.left) <= 1 &&
        Math.abs(kpiRect.right - cardRect.right) <= 1
      ),
    };
  });
  if (
    state.ruleTriggerHeight < 24 ||
    state.ruleTriggerFont < 14 ||
    state.todayLinkHeight < 24 ||
    state.todayLinkFont < 14 ||
    !state.railAligned
  ) {
    throw new Error(`Sales utility control floor mismatch: ${JSON.stringify(state)}`);
  }
  if (
    state.mobile &&
    (!state.chartBeforeSignals || state.referenceOpen || !state.primaryVisible || !state.todayVisible)
  ) {
    throw new Error(`Sales Overview mobile hierarchy mismatch: ${JSON.stringify(state)}`);
  }
  if (!state.mobile && state.referenceOpen)
    throw new Error('Sales Overview desktop reference context should remain secondary');
}

async function verifySalesChartHeader(page) {
  await wait(page, '#monthChart .dpp-bar');
  const state = await page.evaluate(() => {
    const header = document.querySelector('.sales-chart-header');
    const copy = header?.firstElementChild;
    const control = header?.querySelector('.sales-range');
    const card = header?.closest('.sales-chart-card');
    const bounds = element => element?.getBoundingClientRect();
    const headerBounds = bounds(header);
    const copyBounds = bounds(copy);
    const controlBounds = bounds(control);
    const cardBounds = bounds(card);
    const buttons = [...(control?.querySelectorAll('button') || [])].map(button => {
      const rect = bounds(button);
      return { width: rect.width, height: rect.height };
    });
    const stacked = window.innerWidth <= 640;
    return {
      width: window.innerWidth,
      title: document.getElementById('salesChartTitle')?.textContent.trim() || '',
      subtitle: document.getElementById('salesChartSub')?.textContent.trim() || '',
      copyWidth: copyBounds?.width || 0,
      headerContained: Boolean(
        headerBounds && cardBounds &&
        headerBounds.left >= cardBounds.left - 1 && headerBounds.right <= cardBounds.right + 1
      ),
      controlContained: Boolean(
        controlBounds && cardBounds &&
        controlBounds.left >= cardBounds.left - 1 && controlBounds.right <= cardBounds.right + 1
      ),
      headerInternalOverflow: Boolean(header && header.scrollWidth > header.clientWidth + 1),
      cardInternalOverflow: Boolean(card && card.scrollWidth > card.clientWidth + 1),
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      stackedOwnership: Boolean(
        !stacked ||
        (header && getComputedStyle(header).display === 'grid' &&
          headerBounds && controlBounds && Math.abs(headerBounds.left - controlBounds.left) <= 1 &&
          Math.abs(headerBounds.right - controlBounds.right) <= 1)
      ),
      desktopOwnership: Boolean(
        stacked ||
        (header && getComputedStyle(header).display === 'flex' && copyBounds?.width >= 220 &&
          controlBounds?.width <= 300)
      ),
      buttonTargets: buttons,
    };
  });
  if (
    state.title !== 'Monthly shopper spend' ||
    !state.subtitle ||
    state.copyWidth < 220 ||
    !state.headerContained ||
    !state.controlContained ||
    state.headerInternalOverflow ||
    state.cardInternalOverflow ||
    state.documentOverflow > 1 ||
    !state.stackedOwnership ||
    !state.desktopOwnership ||
    state.buttonTargets.length !== 5 ||
    state.buttonTargets.some(target => target.width < 44 || target.height < 44)
  ) {
    throw new Error(`Sales chart header boundary mismatch: ${JSON.stringify(state)}`);
  }
}

async function verifySalesProducts(page) {
  await page.locator('button[data-view="products"]').click();
  await wait(page, '#skuRows tr');
  const state = await page.evaluate(async () => {
    const payload = await (await fetch('/api/sales', { cache: 'no-store' })).json();
    const expected = Array.isArray(payload.skus) ? payload.skus : [];
    const rows = [...document.querySelectorAll('#skuRows tr')];
    const control = document.getElementById('productsMore');
    const evidence = document.getElementById('orderEvidence');
    const mobile = window.innerWidth <= 720;
    return {
      mobile,
      total: rows.length,
      expected: expected.length,
      visible: rows.filter(row => getComputedStyle(row).display !== 'none').length,
      controlVisible: Boolean(control && getComputedStyle(control).display !== 'none'),
      expanded: control?.getAttribute('aria-expanded'),
      driverTab: document.querySelector('button[data-view="products"]')?.textContent?.trim(),
      ordersTabRemoved: !document.querySelector('button[data-view="orders"]'),
      readCards: document.querySelectorAll('.product-read__card').length,
      readPopulated: [...document.querySelectorAll('.product-read__value')]
        .every(item => item.textContent.trim() && item.textContent.trim() !== '—'),
      productReadAvailable: Boolean(payload.product_read?.breadth_state),
      orderEvidenceClosed: Boolean(evidence && !evidence.hasAttribute('open')),
      structured: rows.every(row =>
        row.querySelector('.product-line') &&
        row.querySelector('.product-share') &&
        row.querySelector('.product-change') &&
        row.querySelector('.product-movement') &&
        row.querySelector('.state')
      ),
      namesMatch: rows.every(
        (row, index) =>
          row.querySelector('.product-name')?.textContent?.trim() ===
          String(expected[index]?.product || expected[index]?.sku || '').trim()
      ),
      thumbnailsMatch: rows.every((row, index) =>
        expected[index]?.image_url ? Boolean(row.querySelector('.product-thumb')) : true
      ),
    };
  });
  if (
    state.total !== state.expected ||
    state.driverTab !== 'Drivers' ||
    !state.ordersTabRemoved ||
    state.readCards !== 3 ||
    !state.readPopulated ||
    !state.productReadAvailable ||
    !state.orderEvidenceClosed ||
    !state.structured ||
    !state.namesMatch ||
    !state.thumbnailsMatch
  ) {
    throw new Error(`Sales Products contract mismatch: ${JSON.stringify(state)}`);
  }
  if (
    state.mobile &&
    (state.visible !== Math.min(6, state.total) ||
      state.controlVisible !== (state.total > 6) ||
      (state.total > 6 && state.expanded !== 'false'))
  ) {
    throw new Error(`Sales Products mobile density mismatch: ${JSON.stringify(state)}`);
  }
  if (!state.mobile && state.visible !== state.total)
    throw new Error(`Sales Products desktop rows hidden: ${JSON.stringify(state)}`);
}


async function verifyToday(page) {
  await wait(page, '#rhythm .dpp-bar');
  await wait(page, '#dayPicker .day-choice');
  await wait(page, '#products .ops-owned');
  const payload = await page.evaluate(async () => (await (await fetch('/api/today', { cache: 'no-store' })).json()));
  const expectedRows = {
    '7': (payload.recent_daily || []).slice(-7),
    mtd: (payload.recent_daily || []).filter(row =>
      String(row.business_date).slice(0, 7) === String(payload.selected_date).slice(0, 7)
    ),
    '30': (payload.recent_daily || []).slice(-30),
    ytd: payload.daily_history || [],
  };
  for (const period of ['7', 'mtd', '30', 'ytd']) {
    const rows = expectedRows[period];
    if (!rows.length) throw new Error(`Today ${period} API window is empty`);
    await page.locator(`button[data-period="${period}"]`).click();
    await page.locator(`button[data-period="${period}"][aria-pressed="true"]`).waitFor({ state: 'visible', timeout: 5000 });
    const signature = await page.evaluate(() => {
      const bars = [...document.querySelectorAll('#rhythm .dpp-bar')];
      const line = document.querySelector('#rhythm .demand-rhythm__line');
      const chart = document.querySelector('#rhythm');
      const lineStyle = line ? getComputedStyle(line) : null;
      const normalBar = bars.find(bar =>
        !bar.classList.contains('demand-rhythm__bar--exceptional') &&
        !bar.classList.contains('demand-rhythm__bar--weekend')
      ) || bars[0];
      return {
        count: bars.length,
        first: bars[0]?.__data__?.business_date || null,
        last: bars.at(-1)?.__data__?.business_date || null,
        barWidth: Number(bars[0]?.getAttribute('width') || 0),
        slotWidth: bars.length > 1
          ? Math.abs(Number(bars[1]?.getAttribute('x')) - Number(bars[0]?.getAttribute('x')))
          : 0,
        lineStroke: lineStyle?.stroke || '',
        lineWidth: Number.parseFloat(lineStyle?.strokeWidth || '0'),
        barFill: normalBar ? getComputedStyle(normalBar).fill : '',
        viewportWidth: window.innerWidth,
        chartWidth: chart?.getBoundingClientRect().width || 0,
      };
    });
    const expected = {
      count: rows.length,
      first: rows[0]?.business_date || null,
      last: rows.at(-1)?.business_date || null,
    };
    const renderedWindow = {
      count: signature.count,
      first: signature.first,
      last: signature.last,
    };
    if (JSON.stringify(renderedWindow) !== JSON.stringify(expected)) {
      throw new Error(`Today ${period} selected state does not match rendered data: ${JSON.stringify({ signature, expected })}`);
    }
    const minimumShortWindowWidth = Math.min(32, signature.slotWidth * 0.35);
    const underweightedBars = period === '7'
      ? signature.barWidth < minimumShortWindowWidth
      : rows.length <= 45
        ? signature.barWidth / signature.slotWidth < 0.45
        : signature.barWidth / signature.slotWidth < 0.68;
    if (
      underweightedBars ||
      signature.lineStroke === signature.barFill ||
      signature.lineWidth < 2.8
    ) {
      throw new Error(`Today ${period} chart hierarchy is underweighted: ${JSON.stringify(signature)}`);
    }
  }
  await page.locator('button[data-period="30"]').click();
  const dayDates = await page.locator('#dayPicker .day-choice').evaluateAll(buttons =>
    buttons.map(button => button.dataset.date)
  );
  const dayStates = [];
  for (const date of dayDates) {
    await page.locator(`#dayPicker .day-choice[data-date="${date}"]`).click();
    await page.locator(`#dayPicker .day-choice[data-date="${date}"][aria-pressed="true"]`).waitFor({
      state: 'visible',
      timeout: 5000,
    });
    dayStates.push(await page.evaluate(() => {
      const picker = document.getElementById('dayPicker');
      const lead = document.querySelector('.today-lead');
      const head = document.querySelector('.today-lead__head');
      const choices = [...picker.querySelectorAll('.day-choice')];
      const active = picker.querySelector('.day-choice.active');
      const pickerRect = picker.getBoundingClientRect();
      const leadRect = lead.getBoundingClientRect();
      const headStyle = getComputedStyle(head);
      const availableWidth =
        head.clientWidth - Number.parseFloat(headStyle.paddingLeft) - Number.parseFloat(headStyle.paddingRight);
      const tops = choices.map(choice => Math.round(choice.getBoundingClientRect().top));
      const widths = choices.map(choice => choice.getBoundingClientRect().width);
      const heights = choices.map(choice => choice.getBoundingClientRect().height);
      return {
        date: active?.dataset.date || null,
        live: Boolean(active?.classList.contains('live')),
        compact: window.innerWidth <= 900,
        pickerWidth: pickerRect.width,
        pickerHeight: pickerRect.height,
        leadHeight: leadRect.height,
        availableWidth,
        rowSpread: Math.max(...tops) - Math.min(...tops),
        minChoiceWidth: Math.min(...widths),
        minChoiceHeight: Math.min(...heights),
        scrollLeft: picker.scrollLeft,
        scrollMax: picker.scrollWidth - picker.clientWidth,
        activeVisible:
          active.getBoundingClientRect().left >= pickerRect.left - 1 &&
          active.getBoundingClientRect().right <= pickerRect.right + 1,
        urlDate: new URL(window.location.href).searchParams.get('date'),
        stateLabel: document.getElementById('todayDayState')?.textContent.trim() || '',
        title: document.getElementById('todayTitle')?.textContent.trim() || '',
      };
    }));
  }
  const todayDate = dayDates[0];
  await page.locator(`#dayPicker .day-choice[data-date="${todayDate}"]`).click();
  await page.locator(`#dayPicker .day-choice[data-date="${todayDate}"][aria-pressed="true"]`).waitFor({
    state: 'visible',
    timeout: 5000,
  });
  const pickerWidths = dayStates.map(item => item.pickerWidth);
  const pickerHeights = dayStates.map(item => item.pickerHeight);
  const leadHeights = dayStates.map(item => item.leadHeight);
  const unstableDayState =
    Math.max(...pickerWidths) - Math.min(...pickerWidths) > 2 ||
    Math.max(...pickerHeights) - Math.min(...pickerHeights) > 2 ||
    Math.max(...leadHeights) - Math.min(...leadHeights) > 2 ||
    dayStates.some(item =>
      (item.compact && Math.abs(item.pickerWidth - item.availableWidth) > 2) ||
      item.rowSpread > 2 ||
      item.minChoiceWidth < 44 ||
      item.minChoiceHeight < 44 ||
      !item.activeVisible ||
      item.urlDate !== (item.live ? null : item.date) ||
      (item.live
        ? item.stateLabel !== 'Live operating day' || item.title !== 'Today'
        : item.stateLabel !== 'Closed operating day' || item.title === 'Today')
    );
  if (unstableDayState) {
    throw new Error(`Today operating-day selector is unstable: ${JSON.stringify(dayStates)}`);
  }
  const state = await page.evaluate(() => {
    const mobile = window.innerWidth <= 640;
    const main = document.querySelector('.today-main');
    const overview = document.querySelector('[data-dpp-qa="today-overview"]');
    const queue = document.querySelector('.order-flow-panel');
    const drivers = document.querySelector('.today-drivers-panel');
    const rhythm = document.querySelector('[data-dpp-qa="today-rhythm"]');
    const operations = document.querySelector('.today-operations');
    const primary = document.querySelector('.workspace-grid--today-primary');
    const evidenceSection = document.querySelector('.today-evidence');
    const evidence = document.getElementById('todayBusinessEvidence');
    const reference = document.getElementById('todayProductsReference');
    const priority = [...document.querySelectorAll('.today-products-priority .today-product')];
    const dayPicker = document.getElementById('dayPicker');
    const dayPickerRect = dayPicker?.getBoundingClientRect();
    const rhythmKpis = [...document.querySelectorAll('.rhythm-kpi')];
    const tops = rhythmKpis.map(item => Math.round(item.getBoundingClientRect().top));
    const productValues = priority.map(card => {
      const value = card.querySelector('.value');
      const amount = value?.querySelector(':scope > strong');
      const share = value?.querySelector(':scope > .share');
      const amountRect = amount?.getBoundingClientRect();
      const shareRect = share?.getBoundingClientRect();
      const overlapX =
        amountRect && shareRect
          ? Math.min(amountRect.right, shareRect.right) - Math.max(amountRect.left, shareRect.left)
          : 0;
      const overlapY =
        amountRect && shareRect
          ? Math.min(amountRect.bottom, shareRect.bottom) - Math.max(amountRect.top, shareRect.top)
          : 0;
      return {
        structured: Boolean(value && amount && share && getComputedStyle(value).display === 'grid'),
        separated: Boolean(amountRect && shareRect && !(overlapX > 1 && overlapY > 1)),
        amount: amount?.textContent || '',
        share: share?.textContent || '',
      };
    });
    return {
      mobile,
      recipeMatch: Boolean(
        main &&
          [...main.children].every(
            (child, index) => child === [overview, primary, evidenceSection][index]
          ) &&
          main.children.length === 3 &&
          primary?.children[0] === rhythm &&
          primary?.children[1] === operations
      ),
      queueBeforeDrivers: Boolean(
        queue && drivers && queue.getBoundingClientRect().top <= drivers.getBoundingClientRect().top
      ),
      evidenceOpen: Boolean(evidence?.hasAttribute('open')),
      referencePresent: Boolean(reference),
      referenceOpen: Boolean(reference?.hasAttribute('open')),
      priorityCards: priority.length,
      priorityVisible: priority.filter(item => item.getBoundingClientRect().height > 0).length,
      rhythmKpis: rhythmKpis.length,
      rhythmTopSpread: tops.length ? Math.max(...tops) - Math.min(...tops) : null,
      dayPickerContained: Boolean(
        dayPickerRect && dayPickerRect.left >= -2 && dayPickerRect.right <= window.innerWidth + 2
      ),
      productValues,
      evidenceBottomContained: (() => {
        const sectionRect = evidenceSection?.getBoundingClientRect();
        const lastRect = document.getElementById('ordersPanel')?.getBoundingClientRect();
        return Boolean(sectionRect && lastRect && sectionRect.bottom - lastRect.bottom >= 20);
      })(),
    };
  });
  if (!state.dayPickerContained || !state.evidenceBottomContained)
    throw new Error(`Today day picker overflow: ${JSON.stringify(state)}`);
  if (
    state.productValues.some(
      value =>
        !value.structured ||
        !value.separated ||
        /\$(?=\d)/.test(value.amount) ||
        !/% of shopper spend$/.test(value.share),
    )
  ) {
    throw new Error(`Today product contribution collision: ${JSON.stringify(state.productValues)}`);
  }
  if (
    state.mobile &&
    (!state.recipeMatch ||
      !state.queueBeforeDrivers ||
      state.evidenceOpen ||
      (state.referencePresent && state.referenceOpen) ||
      state.priorityCards > 3 ||
      state.priorityCards !== state.priorityVisible ||
      state.rhythmKpis !== 3 ||
      state.rhythmTopSpread > 2)
  ) {
    throw new Error(`Today mobile hierarchy mismatch: ${JSON.stringify(state)}`);
  }
  if (!state.mobile && (!state.evidenceOpen || (state.referencePresent && !state.referenceOpen)))
    throw new Error(`Today desktop evidence is collapsed: ${JSON.stringify(state)}`);
}

async function verifySalesGeography(page) {
  await wait(page, '#geoRankedRows tr');
  await wait(page, '#geoMap .geo-shape');
  const signatures = [];
  for (const range of ['30d', '90d', 'ytd', 'all']) {
    await page.locator(`button[data-geo-range="${range}"]`).click();
    await page.locator(`button[data-geo-range="${range}"][aria-pressed="true"]`).waitFor({ state: 'visible', timeout: 5000 });
    signatures.push(await page.evaluate(key => ({
      key,
      kpis: document.getElementById('geoKpis')?.innerText.trim() || '',
      rows: document.querySelectorAll('#geoRankedRows tr').length,
    }), range));
  }
  if (new Set(signatures.map(item => item.kpis)).size !== signatures.length) {
    throw new Error(`Sales Geography ranges do not update every KPI state: ${JSON.stringify(signatures)}`);
  }

  const layout = await page.evaluate(() => {
    const mobile = window.innerWidth <= 720;
    const workspace = document.querySelector('.geography-workspace');
    const grid = document.querySelector('#geography .geo-grid');
    const map = document.querySelector('.geo-map-panel');
    const ranked = document.querySelector('.geo-ranked-panel');
    const scroll = ranked?.querySelector('.data-table-scroll');
    const headerLabels = [...(ranked?.querySelectorAll('.geo-table thead button') || [])]
      .filter((button) => button.getClientRects().length > 0)
      .map((button) => ({ text: button.textContent.trim(), rect: button.getBoundingClientRect() }));
    const headerOverlaps = [];
    for (let index = 0; index < headerLabels.length; index += 1) {
      for (let next = index + 1; next < headerLabels.length; next += 1) {
        const left = headerLabels[index];
        const right = headerLabels[next];
        const overlapX = Math.min(left.rect.right, right.rect.right) - Math.max(left.rect.left, right.rect.left);
        const overlapY = Math.min(left.rect.bottom, right.rect.bottom) - Math.max(left.rect.top, right.rect.top);
        if (overlapX > 1 && overlapY > 1) headerOverlaps.push([left.text, right.text]);
      }
    }
    const clippedKpis = [...document.querySelectorAll('.geo-kpi span, .geo-kpi small')]
      .filter((node) => node.getClientRects().length > 0 && node.scrollWidth > node.clientWidth + 2)
      .map((node) => node.textContent.trim());
    const rankedRows = [...(ranked?.querySelectorAll('#geoRankedRows tr') || [])];
    const workspaceRect = workspace?.getBoundingClientRect();
    const rankedRect = ranked?.getBoundingClientRect();
    return {
      mobile,
      pageOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      columns: getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length,
      stacked: Boolean(map && ranked && ranked.getBoundingClientRect().top >= map.getBoundingClientRect().bottom - 2),
      rankedContained: Boolean(
        workspaceRect && rankedRect &&
        rankedRect.left >= workspaceRect.left - 2 &&
        rankedRect.right <= workspaceRect.right + 2
      ),
      mobileCards: Boolean(
        scroll &&
          scroll.scrollWidth <= scroll.clientWidth + 2 &&
          rankedRows.length &&
          rankedRows.every(
            (row) =>
              getComputedStyle(row).display === 'grid' &&
              row.querySelectorAll('td.num[data-label]').length === 4,
          )
      ),
      headerOverlaps,
      clippedKpis,
    };
  });
  if (layout.pageOverflow > 2 || !layout.rankedContained || layout.headerOverlaps.length) {
    throw new Error(`Sales Geography containment mismatch: ${JSON.stringify(layout)}`);
  }
  if (
    layout.mobile &&
    (layout.columns !== 1 ||
      !layout.stacked ||
      !layout.mobileCards ||
      layout.clippedKpis.length)
  ) {
    throw new Error(`Sales Geography mobile reflow mismatch: ${JSON.stringify(layout)}`);
  }
}

async function verifyBusiness(page) {
  await wait(page, '#stateHeadline');
  await verifyCompactLead(page, '[data-dpp-qa="business-demand"]');
  const state = await page.evaluate(async () => {
    const payload = await (await fetch('/api/home', { cache: 'no-store' })).json();
    const exceptions = (payload.inventory || []).filter((item) =>
      ['STOCKOUT', 'PRODUCE', 'PLAN'].includes(String(item.action || '').toUpperCase()),
    );
    const total = Math.max(exceptions.length, Number(payload.inventory_summary?.needs_action || 0));
    const main = document.querySelector('main.home-main');
    const sections = main ? [...main.children].filter(element => element.matches('section')) : [];
    const overview = document.querySelector('[data-dpp-qa="business-overview"]');
    const demand = document.querySelector('[data-dpp-qa="business-demand"]');
    const decisions = document.querySelector('[data-dpp-qa="business-decisions"]');
    const health = document.querySelector('[data-dpp-qa="business-health"]');
    const secondary = document.querySelector('.workspace-grid--business-secondary');
    const dataHealthCard = document.querySelector('.business-health-card[href="/data-health"]');
    const healthContract = payload.health_contract || {};
    const pipelineScope = healthContract.pipeline_scope || {};
    const healthOverall = healthContract.overall || {};
    const ads = document.getElementById('adsRead');
    const brand = document.querySelector('.topbar a.brand');
    const footer = document.querySelector('.footer');
    const explanation = String(payload.business_momentum?.explanation || '').trim();
    const expectedHeadline =
      (explanation.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [])[0]?.trim() ||
      'Current business evidence';
    const top = (element) => element?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
    const precedes = (before, after) =>
      Boolean(
        before &&
          after &&
          (before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING),
      );
    return {
      evidenceHeadline: document.getElementById('stateHeadline')?.textContent?.trim(),
      expectedHeadline,
      activeNav: document.querySelector('.nav-primary-set a.active')?.textContent?.trim(),
      brandPath: brand ? new URL(brand.href).pathname : '',
      singleRead: Boolean(
        main &&
          document.querySelectorAll('main').length === 1 &&
          main.querySelectorAll('h1').length === 1 &&
          main.querySelector('h1')?.textContent?.trim() === 'Business' &&
          document.getElementById('stateHeadline')?.textContent?.trim() === expectedHeadline &&
          main.children.length === 3,
      ),
      hierarchy: Boolean(
        sections[0] === overview &&
          sections[1] === demand &&
          sections.length === 2 &&
          overview?.parentElement === main &&
          demand?.parentElement === main &&
          secondary?.parentElement === main &&
          decisions?.parentElement === secondary &&
          health?.parentElement === secondary &&
          secondary.children[0] === decisions &&
          secondary.children[1] === health &&
          precedes(overview, demand) &&
          precedes(demand, decisions) &&
          precedes(decisions, health),
      ),
      exceptionItems: document.querySelectorAll('.attention-item').length,
      severityBadges: document.querySelectorAll('.attention-item .severity-badge').length,
      clearState: Boolean(document.querySelector('.attention-clear')),
      moreVisible: Boolean(document.querySelector('.attention-more')),
      expectedItems: Math.min(4, exceptions.length),
      expectedMore: exceptions.length > 0 && total > Math.min(4, exceptions.length),
      healthDomains: document.querySelectorAll('.business-health-card').length,
      healthContractId: healthContract.contract_id,
      healthValue: dataHealthCard?.querySelector('.business-health-card__value')?.textContent?.trim(),
      expectedHealthValue: pipelineScope.total
        ? `${pipelineScope.healthy}/${pipelineScope.total}`
        : '—',
      healthCopy: dataHealthCard?.querySelector('p')?.textContent || '',
      healthConditionCount: Number(healthOverall.active_condition_count || 0),
      healthAffectedDomains: healthOverall.affected_domains || [],
      rhythmCurrentBand: document.querySelectorAll('#spark .demand-rhythm__current-period').length,
      rhythmLatestRead: Boolean(
        document.querySelector('#spark .demand-rhythm__latest-dot') &&
          document.querySelector('#spark .demand-rhythm__latest-label'),
      ),
      rhythmExceptionalDays: document.querySelectorAll(
        '#spark .demand-rhythm__bar--exceptional',
      ).length,
      rhythmWeekendDays: document.querySelectorAll('#spark .demand-rhythm__bar--weekend').length,
      signalCopy: document
        .querySelector('[data-dpp-qa="business-demand"] .section-header__description')
        ?.textContent?.replace(/\s+/g, ' ')
        .toLowerCase()
        .includes('seven-day signal'),
      productDriversRemoved: !document.querySelector('.drivers, #movers, .driver'),
      adsVisible: Boolean(ads && !ads.hidden && getComputedStyle(ads).display !== 'none'),
      adsExpected: Boolean(payload.ads?.through_date),
      adsAfterHealth: !ads || ads.hidden || top(health) < top(ads),
      footerGap: footer && secondary
        ? footer.getBoundingClientRect().top - secondary.getBoundingClientRect().bottom
        : 0,
    };
  });
  if (
    state.evidenceHeadline !== state.expectedHeadline ||
    state.activeNav !== 'Business' ||
    state.brandPath !== '/' ||
    !state.singleRead ||
    !state.hierarchy ||
    state.exceptionItems !== state.expectedItems ||
    state.severityBadges !== state.expectedItems ||
    state.clearState !== (state.expectedItems === 0) ||
    state.moreVisible !== state.expectedMore ||
    state.healthDomains !== 3 ||
    state.healthContractId !== 'BUSINESS_DECISION_HEALTH_V1' ||
    state.healthValue !== state.expectedHealthValue ||
    !state.healthCopy.includes('outside this six-stream count') ||
    (state.healthConditionCount > 0 &&
      !state.healthAffectedDomains.every(domain => state.healthCopy.includes(domain))) ||
    state.rhythmCurrentBand !== 1 ||
    !state.rhythmLatestRead ||
    state.rhythmExceptionalDays < 1 ||
    state.rhythmWeekendDays < 1 ||
    !state.signalCopy ||
    !state.productDriversRemoved ||
    state.adsVisible !== state.adsExpected ||
    !state.adsAfterHealth ||
    state.footerGap < 24
  ) {
    throw new Error(`Business decision-board contract mismatch: ${JSON.stringify(state)}`);
  }
  await page.locator('button[data-home-window="ytd"]').click();
  await page
    .locator('button[data-home-window="ytd"][aria-pressed="true"]')
    .waitFor({ state: 'visible', timeout: 5000 });
  const ytd = await page.evaluate(() => {
    const bars = [...document.querySelectorAll('#spark .demand-rhythm__bar')];
    const first = bars[0]?.__data__?.business_date || '';
    const last = bars.at(-1)?.__data__?.business_date || '';
    const year = last.slice(0, 4);
    const xAxis = [...document.querySelectorAll('#spark .dpp-axis')].at(-1);
    const labels = [...(xAxis?.querySelectorAll('.tick text') || [])].map((tick) =>
      tick.textContent.trim(),
    );
    const description = document.getElementById('homeDemandDescription')?.textContent.trim() || '';
    return {
      first,
      last,
      yearStart: `${year}-01-01`,
      labels,
      description,
      availabilityDisclosed:
        first === `${year}-01-01` || description.includes('available history begins'),
    };
  });
  if (
    ytd.labels[0] !== 'Jan' ||
    !ytd.description.startsWith('Year to date') ||
    !ytd.availabilityDisclosed
  ) {
    throw new Error(`Business YTD is not anchored to the calendar year: ${JSON.stringify(ytd)}`);
  }
}
async function verifyDataHealth(page) {
  await assertWorkspaceLandmarks(page, ['data-health-overview', 'catalog-onboarding']);
  await wait(page, '.health-summary');
  await wait(page, '#jobs > *');
  const state = await page.evaluate(async () => {
    const [response, homeResponse] = await Promise.all([
      fetch('/api/data-health', { cache: 'no-store' }),
      fetch('/api/home', { cache: 'no-store' }),
    ]);
    const [payload, home] = await Promise.all([response.json(), homeResponse.json()]);
    const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
    const healthContract = payload.health_contract || {};
    const problem = job =>
      job.latest_status === 'error' ||
      job.latest_status === 'interrupted' ||
      job.is_stale ||
      !['success', 'running'].includes(job.latest_status);
    const problems = jobs.filter(problem);
    const attention = document.getElementById('attentionSection');
    const incidents = [...document.querySelectorAll('.incident')];
    return {
      apiOk: response.ok,
      homeApiOk: homeResponse.ok,
      checkedAt: payload.checked_at,
      jobs: jobs.length,
      contractComplete: jobs.every(job =>
        job.label &&
        job.operation &&
        job.purpose &&
        job.domain &&
        Number(job.expected_interval_seconds) > 0 &&
        Number(job.stale_after_seconds) >= Number(job.expected_interval_seconds) &&
        typeof job.is_stale === 'boolean' &&
        'records_read' in job &&
        'records_written' in job &&
        'last_success_at' in job &&
        'error_message' in job
      ),
      problems: problems.length,
      renderedJobs: document.querySelectorAll('#jobs .health-job').length,
      syncActions: [...document.querySelectorAll('#jobs .sync-now')].filter(
        button => button.getClientRects().length > 0
      ).length,
      toggleExpanded: document.getElementById('toggle')?.getAttribute('aria-expanded'),
      toggleCopy: document.getElementById('toggle')?.textContent?.trim(),
      emptyConfirmation:
        problems.length > 0 ||
        document.getElementById('jobs')?.textContent?.includes('No pipeline exceptions.'),
      attentionVisible: Boolean(attention && !attention.hidden),
      incidents: incidents.length,
      incidentStructure: incidents.every(incident =>
        incident.querySelector('.incident__purpose') &&
        incident.querySelectorAll('.incident__metrics > div').length === 4 &&
        incident.querySelector('.incident__diagnostic')
      ),
      compactCoverage: Boolean(document.querySelector('.domain-summary .domain-chip')),
      healthContractId: healthContract.contract_id,
      sharedContract: JSON.stringify(healthContract) === JSON.stringify(home.health_contract || {}),
      scopeDefined:
        healthContract.pipeline_scope?.total === 6 &&
        healthContract.pipeline_scope?.included?.length === 6 &&
        Array.isArray(healthContract.pipeline_scope?.excluded) &&
        Boolean(healthContract.pipeline_scope?.exclusion_rule),
      stateMappingDefined:
        healthContract.domains?.filter(domain => domain.critical).length === 5 &&
        Number.isInteger(healthContract.overall?.active_condition_count) &&
        Array.isArray(healthContract.overall?.affected_domains),
      renderedConditionCount: Number(document.getElementById('summaryCount')?.textContent),
      expectedConditionCount: Number(healthContract.overall?.active_condition_count || 0),
      warehouseClosed: !document.querySelector('.warehouse-reference')?.hasAttribute('open'),
      warehouseSummaryHeight:
        document.querySelector('.warehouse-reference summary')?.getBoundingClientRect().height || 0,
      genericRingRemoved: !document.getElementById('ring'),
      refreshCopy: document.getElementById('healthUpdated')?.textContent || '',
      pipelineHeight:
        document
          .querySelector('[data-dpp-qa="data-health-pipeline"]')
          ?.getBoundingClientRect().height || 0,
      documentHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
      mobilePipelineMetrics:
        window.innerWidth > 640 ||
        ([...document.querySelectorAll('#jobs .health-job')].length === problems.length &&
          [...document.querySelectorAll('#jobs .health-job')].every(row =>
            [
              row.querySelector('.health-job__age'),
              row.querySelector('.health-job__cadence'),
              row.querySelector('.health-job__rows'),
              row.querySelector('.health-job__purpose'),
            ].every(metric => metric && window.getComputedStyle(metric).display !== 'none')
          )),
      pipelineTable:
        document.querySelector('.pipeline-panel [role="table"]')?.getAttribute('aria-label') === 'Pipeline health' &&
        document.querySelectorAll('.health-job--header [role="columnheader"]').length === 5 &&
        [...document.querySelectorAll('#jobs .health-job')].every(row => row.getAttribute('role') === 'row' && row.querySelectorAll('[role="cell"]').length === 5),
      desktopHeaderInset: (() => {
        if (window.innerWidth <= 900) return true;
        const body = document.querySelector('.pipeline-panel .panel__body')?.getBoundingClientRect();
        const first = document.querySelector('.health-job--header [role="columnheader"]')?.getBoundingClientRect();
        return Boolean(body && first && first.left - body.left >= 11);
      })(),
      mobileHeaderAvailable:
        window.innerWidth > 900 || window.getComputedStyle(document.querySelector('.health-job--header')).display !== 'none',
      evidenceFloor: [...document.querySelectorAll(
        '.health-copy,.health-updated,.incident__purpose,.incident__metrics dt,.incident__metrics small,.domain-chip strong,.domain-chip small,.health-job__name,.health-job__source,.health-job__metric,.catalog-health-item__identity,.catalog-health-item__state,.catalog-health-item__timing'
      )]
        .filter(node => node.getClientRects().length > 0)
        .every(node => Number.parseFloat(getComputedStyle(node).fontSize) >= 14),
      controlFloor: [...document.querySelectorAll('.data-health-page button,.warehouse-reference summary')]
        .filter(node => node.getClientRects().length > 0)
        .every(node => node.getBoundingClientRect().height >= 40),
    };
  });
  if (
    !state.apiOk ||
    !state.homeApiOk ||
    !state.checkedAt ||
    !state.jobs ||
    state.renderedJobs !== state.problems ||
    state.syncActions !== state.problems ||
    state.toggleExpanded !== 'false' ||
    state.toggleCopy !== 'All jobs' ||
    !state.emptyConfirmation ||
    !state.contractComplete ||
    !state.compactCoverage ||
    state.healthContractId !== 'BUSINESS_DECISION_HEALTH_V1' ||
    !state.sharedContract ||
    !state.scopeDefined ||
    !state.stateMappingDefined ||
    state.renderedConditionCount !== state.expectedConditionCount ||
    !state.warehouseClosed ||
    state.warehouseSummaryHeight < 44 ||
    !state.genericRingRemoved ||
    !state.mobilePipelineMetrics ||
    !state.pipelineTable ||
    !state.desktopHeaderInset ||
    !state.mobileHeaderAvailable ||
    !state.evidenceFloor ||
    !state.controlFloor ||
    !state.refreshCopy.includes('refreshes every 60s') ||
    (state.problems === 0 &&
      (state.pipelineHeight > 340 ||
        state.documentHeight > Math.max(1400, state.viewportHeight))) ||
    state.attentionVisible !== Boolean(state.problems) ||
    state.incidents !== state.problems ||
    (state.problems > 0 && !state.incidentStructure)
  ) {
    throw new Error(`Data Health diagnostic contract mismatch: ${JSON.stringify(state)}`);
  }

  await page.locator('#toggle').click();
  await page.waitForFunction(
    expected => document.querySelectorAll('#jobs .health-job').length === expected,
    state.jobs,
  );
  const expandedState = await page.evaluate(() => ({
    expanded: document.getElementById('toggle')?.getAttribute('aria-expanded'),
    copy: document.getElementById('toggle')?.textContent?.trim(),
    rows: document.querySelectorAll('#jobs .health-job').length,
    syncActions: document.querySelectorAll('#jobs .sync-now').length,
    detailsVisible:
      window.innerWidth > 640 ||
      [...document.querySelectorAll('#jobs .health-job')].every(row =>
        [
          row.querySelector('.health-job__age'),
          row.querySelector('.health-job__cadence'),
          row.querySelector('.health-job__rows'),
          row.querySelector('.health-job__purpose'),
        ].every(metric => metric && window.getComputedStyle(metric).display !== 'none'),
      ),
  }));
  if (
    expandedState.expanded !== 'true' ||
    expandedState.copy !== 'Problems only' ||
    expandedState.rows !== state.jobs ||
    expandedState.syncActions !== state.jobs ||
    !expandedState.detailsVisible
  ) {
    throw new Error(`Data Health All jobs contract mismatch: ${JSON.stringify(expandedState)}`);
  }

  await page.locator('#toggle').click();
  await page.waitForFunction(
    expected => document.querySelectorAll('#jobs .health-job').length === expected,
    state.problems,
  );
  const collapsedState = await page.evaluate(() => ({
    expanded: document.getElementById('toggle')?.getAttribute('aria-expanded'),
    copy: document.getElementById('toggle')?.textContent?.trim(),
    rows: document.querySelectorAll('#jobs .health-job').length,
    empty: document.getElementById('jobs')?.textContent?.includes('No pipeline exceptions.'),
  }));
  if (
    collapsedState.expanded !== 'false' ||
    collapsedState.copy !== 'All jobs' ||
    collapsedState.rows !== state.problems ||
    (state.problems === 0 && !collapsedState.empty)
  ) {
    throw new Error(`Data Health Problems only contract mismatch: ${JSON.stringify(collapsedState)}`);
  }
}

async function catalogSemantic(page) {
  return page.evaluate(async () => {
    const response = await fetch('/api/catalog', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) return { errors: [`catalog API ${response.status}`] };
    const errors = [];
    const close = (a, b, tolerance = 0.02) => Math.abs(Number(a || 0) - Number(b || 0)) <= tolerance;
    if (!data.summary?.taxonomy_override_configured) errors.push('seller taxonomy is not configured');
    const unmappedSkus = data.summary?.taxonomy_unmapped_skus || [];
    if (unmappedSkus.length) errors.push(`sellable SKUs missing seller taxonomy: ${unmappedSkus.join(', ')}`);
    for (const family of data.families || []) {
      // Amazon lifecycle markers are operational metadata, never commercial family names.
      if (/\b(actual|archivo)\b/i.test(String(family.name || ''))) errors.push(`${family.family_asin}: raw Amazon lifecycle label leaked into family name`);
      const members = (family.members || []).filter(x => ['SELLABLE_VARIATION', 'SELLABLE_STANDALONE'].includes(x.product_role));
      if (!members.length) continue;
      const sum = key => members.reduce((n, x) => n + Number(x[key] || 0), 0);
      const sales = sum('sales_t28'), units = sum('units_t28'), sessions = sum('sessions_t28');
      if (!close(family.sales_t28, sales)) errors.push(`${family.family_asin}: family sales != child rollup`);
      if (Number(family.units_t28 || 0) !== units) errors.push(`${family.family_asin}: family units != child rollup`);
      if (Number(family.sessions_t28 || 0) !== sessions) errors.push(`${family.family_asin}: family sessions != child rollup`);
      if (Number(family.available || 0) !== sum('available') || Number(family.inbound || 0) !== sum('inbound')) errors.push(`${family.family_asin}: family inventory != child rollup`);
      const expectedCvr = sessions > 0 ? Math.round(10000 * units / sessions) / 100 : null;
      if (expectedCvr === null ? family.conversion_t28_pct != null : !close(family.conversion_t28_pct, expectedCvr)) errors.push(`${family.family_asin}: family CVR not recomputed`);
      if (family.parent && family.primary_state === 'STRUCTURAL_PARENT') errors.push(`${family.family_asin}: structural parent used as diagnosis`);
      if ((family.members || []).some(x => x.product_role === 'STRUCTURAL_PARENT')) errors.push(`${family.family_asin}: structural parent leaked into members`);
    }
    const dimensionNames = Object.keys(data.dimensions || {});
    if ((data.summary?.amazon_dimension_coverage || 0) > 0 && !dimensionNames.length) errors.push('variation metadata exists but dimensional rollups are empty');
    for (const [dimension, rows] of Object.entries(data.dimensions || {})) for (const row of rows || []) {
      const sessions = Number(row.sessions_t28 || 0), units = Number(row.units_t28 || 0);
      const expected = sessions > 0 ? Math.round(10000 * units / sessions) / 100 : null;
      if (expected === null ? row.conversion_t28_pct != null : !close(row.conversion_t28_pct, expected)) errors.push(`${dimension}/${row.value}: dimensional CVR not recomputed`);
    }
    return { errors, dimensionNames, pairCount: (data.dimension_pairs || []).length };
  });
}

async function verifyCatalog(page) {
  await assertWorkspaceLandmarks(page, ['catalog-overview', 'catalog-controls', 'catalog-evidence']);
  await page.locator('.family').first().waitFor({ state: 'visible', timeout: 15000 });
  await verifyCompactLead(page, '[data-dpp-qa="catalog-evidence"]');
  const semantic = await catalogSemantic(page);
  if (semantic.errors?.length) throw new Error(`Catalog semantic QA: ${semantic.errors.join('; ')}`);
  const openCount = await page.locator('.family[open]').count();
  if (openCount) throw new Error(`Catalog default comparison view has ${openCount} family expansions open`);

  if ((await page.evaluate(() => window.innerWidth)) <= 720) {
    const mobile = await page.evaluate(() => {
      const summary = document.querySelector('.family > summary');
      const metrics = summary
        ? [...summary.querySelectorAll(':scope > .metric-sales, :scope > .metric-funnel, :scope > .metric-stock')]
        : [];
      const tops = metrics.map((metric) => Math.round(metric.getBoundingClientRect().top));
      const clipped = metrics.flatMap((metric) => [metric, ...metric.querySelectorAll('*')]).filter(
        (node) => node.getClientRects().length > 0 && node.scrollWidth > node.clientWidth + 2,
      );
      const economics = summary?.querySelector(':scope > .economics');
      return {
        duplicateTitleVisible: Boolean(
          document.querySelector('.catalog-title') &&
            getComputedStyle(document.querySelector('.catalog-title')).display !== 'none',
        ),
        economicsVisible: Boolean(economics && getComputedStyle(economics).display !== 'none'),
        metricCount: metrics.length,
        metricTopSpread: tops.length ? Math.max(...tops) - Math.min(...tops) : null,
        firstRowSpread: tops.length >= 2 ? Math.abs(tops[0] - tops[1]) : null,
        stockBelow: tops.length === 3 ? tops[2] > tops[0] + 20 : false,
        clippedMetrics: clipped.map((node) => node.textContent.trim().slice(0, 80)),
      };
    });
    if (mobile.duplicateTitleVisible) throw new Error('Catalog mobile repeats the portfolio title');
    if (mobile.economicsVisible) throw new Error('Catalog mobile exposes desktop economics in the family summary');
    if (
      mobile.metricCount !== 3 ||
      mobile.firstRowSpread > 2 ||
      !mobile.stockBelow ||
      mobile.metricTopSpread < 20 ||
      mobile.clippedMetrics.length
    )
      throw new Error(
        `Catalog mobile metrics are not a readable two-row grid: ${JSON.stringify(mobile)}`,
      );
  }
}

async function verifyCatalogMode(page, mode) {
  await verifyCatalog(page);
  const semantic = await catalogSemantic(page);
  if (mode.startsWith('dimension:') && !semantic.dimensionNames?.includes(mode.split(':')[1])) throw new Error(`Catalog dimension ${mode.split(':')[1]} unavailable`);
  if (mode === 'pair' && !semantic.pairCount) throw new Error('Catalog variation-combination rollups unavailable');
  const button = page.locator(`button[data-mode="${mode}"]`);
  await button.waitFor({ state: 'visible', timeout: 5000 });
  await button.click();
  await wait(page, '.analysis-row');
  const mobileDensity = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.portfolio .analysis-row')];
    const disclosure = document.querySelector('.catalog-reference-disclosure');
    const evidence = document.querySelector('.catalog-evidence');
    return {
      mobile: window.innerWidth <= 720,
      total: rows.length,
      visible: rows.filter((row) => row.getClientRects().length > 0).length,
      disclosure: Boolean(disclosure),
      disclosureOpen: Boolean(disclosure?.hasAttribute('open')),
      semanticTable: evidence?.getAttribute('role') === 'table',
      columnHeaders: document.querySelectorAll('#portfolioHead [role="columnheader"]').length,
      rowGroup: document.getElementById('portfolio')?.getAttribute('role') === 'rowgroup',
      semanticRows: rows.every(row =>
        row.getAttribute('role') === 'row' &&
        row.querySelectorAll(':scope > [role="rowheader"]').length === 1 &&
        row.querySelectorAll(':scope > [role="cell"]').length === 6
      ),
    };
  });
  if (
    !mobileDensity.semanticTable ||
    mobileDensity.columnHeaders !== 7 ||
    !mobileDensity.rowGroup ||
    !mobileDensity.semanticRows
  ) throw new Error(`Catalog table semantics mismatch: ${JSON.stringify(mobileDensity)}`);
  if (mobileDensity.mobile && mobileDensity.total > 6) {
    if (!mobileDensity.disclosure || mobileDensity.disclosureOpen || mobileDensity.visible !== 6) {
      throw new Error(`Catalog mobile density mismatch: ${JSON.stringify(mobileDensity)}`);
    }
  }
}

async function verifyProductWorkspace(page) {
  await assertWorkspaceLandmarks(page, [
    'product-identity',
    'product-kpis',
    'product-analysis',
    'product-decisions',
    'product-order-evidence',
    'product-family-evidence',
  ]);
  await wait(page, '.hero-name');
  await wait(page, '#chart .dpp-bar');
  await verifyCompactLead(page, '[data-dpp-qa="product-analysis"]');
  const payload = await page.evaluate(async () =>
    (await (await fetch('/api/product?sku=PNC-001', { cache: 'no-store' })).json()),
  );
  const expected = payload.profile?.product;
  if (payload.profile?.label_source !== 'mapping' || !expected)
    throw new Error(`Product mapped-name contract mismatch: ${payload.profile?.product || 'blank'} / ${payload.profile?.label_source || 'unknown source'}`);
  const renderedName = (await page.locator('.hero-name').textContent() || '').trim();
  if (renderedName !== expected)
    throw new Error(`Product hero canonical name mismatch: ${renderedName || 'blank'}`);
  if (await page.locator('script[src*="product-ads-context"]').count())
    throw new Error('Product loaded the superseded Ads post-render module');
  if (await page.locator('#ordersPanel[open]').count())
    throw new Error('Product order evidence is open by default');
  if (payload.commercial?.catalog_membership !== 'DELETED') {
    const adsState = (await page.locator('#adsState').textContent() || '').trim();
    const adsDecision = (await page.locator('#adsDecision').textContent() || '').trim();
    const connection = payload.ads?.connection || {};
    if (adsState !== connection.badge || adsDecision !== connection.headline)
      throw new Error(`Product Ads state-machine mismatch: ${adsState} / ${adsDecision}`);
  }

  const mobileHierarchy = await page.evaluate(() => {
    const mobile = window.innerWidth <= 640;
    const reference = document.getElementById('productReference');
    const listingDetails = document.querySelector('.product-lead-evidence details');
    const healthSignal = document.querySelector('.hero-signal');
    const decisions = document.querySelector('.decision-rail');
    const chart = document.querySelector('.product-chart-panel');
    const summary = reference?.querySelector(':scope > summary');
    return {
      mobile,
      referenceOpen: Boolean(reference?.hasAttribute('open')),
      listingDetailsOpen: Boolean(listingDetails?.hasAttribute('open')),
      healthSignalVisible: Boolean(
        healthSignal &&
          healthSignal.getBoundingClientRect().height > 0 &&
          healthSignal.querySelector('#healthHeadline')?.textContent.trim() &&
          healthSignal.querySelector('#healthRead')?.textContent.trim()
      ),
      decisionsAfterChart: Boolean(
        decisions && chart && decisions.getBoundingClientRect().top >= chart.getBoundingClientRect().top
      ),
      referenceSummaryHeight: summary?.getBoundingClientRect().height || 0,
      catalogTitlePreserved: Boolean(document.querySelector('.hero-catalog-title')),
      metricControls: document.querySelectorAll('[data-metric]').length,
    };
  });
  if (
    mobileHierarchy.mobile &&
    (mobileHierarchy.referenceOpen ||
      mobileHierarchy.listingDetailsOpen ||
      !mobileHierarchy.healthSignalVisible ||
      !mobileHierarchy.decisionsAfterChart ||
      !mobileHierarchy.catalogTitlePreserved ||
      mobileHierarchy.metricControls !== 2 ||
      mobileHierarchy.referenceSummaryHeight < 44)
  ) {
    throw new Error(`Product mobile hierarchy mismatch: ${JSON.stringify(mobileHierarchy)}`);
  }
  if (!mobileHierarchy.mobile && mobileHierarchy.referenceOpen)
    throw new Error('Product desktop secondary context should remain subordinate');

  await page.locator('[data-metric="units"]').click();
  const unitsChartLabel = await page.locator('#chart').getAttribute('aria-label');
  if (!String(unitsChartLabel || '').includes('daily units'))
    throw new Error(`Product units chart toggle failed: ${unitsChartLabel || 'missing label'}`);

  await page.locator('#ordersPanel > summary').click();
  await wait(page, '.product-order');
  const orderEvidence = await page.evaluate(() => {
    const orders = [...document.querySelectorAll('.product-order')];
    return {
      count: orders.length,
      structured: orders.every(order =>
        order.querySelector('.product-order__top') &&
        order.querySelector('.product-order__meta') &&
        order.querySelector('.product-order__item') &&
        order.querySelector('.product-order__foot') &&
        order.querySelector('.order-status-pill') &&
        order.querySelector('.order-badge.fulfillment')
      ),
      visible: orders.filter(order => order.getBoundingClientRect().height > 0).length,
      statuses: orders.map(order => order.querySelector('.order-status-pill')?.textContent || ''),
    };
  });
  if (!orderEvidence.count || !orderEvidence.structured)
    throw new Error(`Product order evidence structure mismatch: ${JSON.stringify(orderEvidence)}`);
  if (orderEvidence.count > 6 && orderEvidence.visible !== 6)
    throw new Error(`Product order evidence preview mismatch: ${JSON.stringify(orderEvidence)}`);
  const leakedOrderPending = orderEvidence.statuses.filter(status =>
    /^pending(?:_availability)?$/i.test(status.trim())
  );
  if (leakedOrderPending.length)
    throw new Error(`Product order evidence leaked raw pending language: ${JSON.stringify(leakedOrderPending)}`);
  if (mobileHierarchy.mobile) await page.locator('#ordersPanel > summary').click();
}

async function verifyProductMissingSku(page) {
  await wait(page, '#productEmptyTitle');
  const state = await page.evaluate(() => {
    const visible = element => Boolean(element?.getClientRects().length);
    const hero = document.getElementById('hero');
    const empty = document.querySelector('.product-empty-state');
    return {
      bodyState: document.body.classList.contains('product-page--empty'),
      title: document.getElementById('productEmptyTitle')?.textContent?.trim(),
      messageWidth: Math.round(empty?.getBoundingClientRect().width || 0),
      heroHeight: Math.round(hero?.getBoundingClientRect().height || 0),
      visibleMainChildren: [...document.querySelectorAll('main > *')].filter(visible).length,
      visibleAnalysis: ['.product-kpi-rail', '.product-workspace', '#ordersPanel', '#productReference']
        .filter(selector => visible(document.querySelector(selector))),
      actions: [...document.querySelectorAll('.product-empty-actions a')].map(link => ({
        href: link.getAttribute('href'),
        height: Math.round(link.getBoundingClientRect().height),
      })),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  const expectedLinks = ['/catalog', '/sales', '/inventory'];
  if (
    !state.bodyState ||
    state.title !== 'Choose a product' ||
    state.messageWidth < 240 ||
    state.heroHeight > 420 ||
    state.visibleMainChildren !== 1 ||
    state.visibleAnalysis.length ||
    state.actions.length !== expectedLinks.length ||
    state.actions.some((action, index) => action.href !== expectedLinks[index] || action.height < 40) ||
    state.overflow > 0
  ) throw new Error(`Product missing-SKU state mismatch: ${JSON.stringify(state)}`);
}

async function verifyProductZeroDemand(page) {
  await wait(page, '#chart .dpp-muted');
  const salesState = await page.evaluate(async () => {
    const payload = await (await fetch('/api/product?sku=PNC-001L', { cache: 'no-store' })).json();
    const rows = (payload.series || []).slice(-28);
    return {
      seriesAllZero: rows.length > 0 && rows.every(row => Number(row.sales || 0) === 0),
      message: document.querySelector('#chart .dpp-muted')?.textContent?.trim(),
      ticks: [...document.querySelectorAll('#chart .dpp-axis text')].map(node => node.textContent.trim()),
      bars: document.querySelectorAll('#chart .dpp-bar').length,
    };
  });
  if (
    !salesState.seriesAllZero ||
    salesState.message !== 'No demand in this range.' ||
    salesState.ticks.length ||
    salesState.bars
  ) {
    throw new Error(`Product zero-sales chart mismatch: ${JSON.stringify(salesState)}`);
  }

  await page.locator('[data-metric="units"]').click();
  await wait(page, '#chart .dpp-muted');
  const unitsState = await page.evaluate(async () => {
    const payload = await (await fetch('/api/product?sku=PNC-001L', { cache: 'no-store' })).json();
    const rows = (payload.series || []).slice(-28);
    return {
      seriesAllZero: rows.length > 0 && rows.every(row => Number(row.units || 0) === 0),
      message: document.querySelector('#chart .dpp-muted')?.textContent?.trim(),
      ticks: [...document.querySelectorAll('#chart .dpp-axis text')].map(node => node.textContent.trim()),
      bars: document.querySelectorAll('#chart .dpp-bar').length,
    };
  });
  if (
    !unitsState.seriesAllZero ||
    unitsState.message !== 'No units ordered in this range.' ||
    unitsState.ticks.length ||
    unitsState.bars
  ) {
    throw new Error(`Product zero-units chart mismatch: ${JSON.stringify(unitsState)}`);
  }
}

async function mockProductZeroDemand(context) {
  await context.route('**/api/product?**', async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('sku') !== 'PNC-001L') {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const payload = await response.json();
    payload.series = (payload.series || []).map(row => ({ ...row, sales: 0, units: 0 }));
    await route.fulfill({ response, json: payload });
  });
}


async function verifyTrajectory(page) {
  await wait(page, '.trajectory-horizon');
  await wait(page, '#chart');
  await wait(page, '.structure-priority .structure-card');
  await verifyCompactLead(page, '[data-dpp-qa="trajectory-evidence"]');
  const state = await page.evaluate(() => {
    const mobile = window.innerWidth <= 640;
    const paid = document.getElementById('paidContext');
    const paidEmpty = paid?.classList.contains('paid-context--empty');
    const guide = document.getElementById('trajectoryGuide');
    const reference = document.getElementById('portfolioReference');
    const chart = document.getElementById('chart');
    const chartHost = chart?.closest('.chart-host');
    const priority = [...document.querySelectorAll('.structure-priority .structure-card')];
    const evidence = [...document.querySelectorAll(
      '.trajectory-page .kicker,.trajectory-page .page-header__description,.trajectory-page .metric-window-note,.trajectory-page .state-read__eyebrow,.trajectory-page .state-read__copy,.trajectory-page .state-read__meta,.trajectory-page .section-header__description',
    )].filter(element => element.getClientRects().length > 0);
    const ruleTrigger = [...document.querySelectorAll('.trajectory-page .rule-trigger')]
      .find(element => element.getClientRects().length > 0);
    const weeks = document.querySelector('.trajectory-weeks');
    const disclosure = document.querySelector('.week-disclosure');
    const weekSummary = disclosure?.querySelector('summary');
    const contained = (child, owner) => {
      const childRect = child?.getBoundingClientRect();
      const ownerRect = owner?.getBoundingClientRect();
      return Boolean(childRect && ownerRect && childRect.left >= ownerRect.left - 1 && childRect.right <= ownerRect.right + 1);
    };
    return {
      mobile,
      emptyPaidVisible: Boolean(paidEmpty && paid && window.getComputedStyle(paid).display !== 'none'),
      guideOpen: Boolean(guide?.hasAttribute('open')),
      referenceOpen: Boolean(reference?.hasAttribute('open')),
      priorityCards: priority.length,
      priorityVisible: priority.filter(card => card.getBoundingClientRect().height > 0).length,
      chartContained: Boolean(
        chart &&
          chartHost &&
          chart.getBoundingClientRect().width <= chartHost.getBoundingClientRect().width + 2 &&
          chartHost.scrollWidth <= chartHost.clientWidth + 2
      ),
      chartBars: chart?.querySelectorAll('.dpp-bar').length || 0,
      progressBars: document.querySelectorAll('progress').length,
      evidenceFloor: evidence.every(element => Number.parseFloat(getComputedStyle(element).fontSize) >= 14),
      ruleTriggerHeight: ruleTrigger?.getBoundingClientRect().height || 0,
      ruleTriggerFont: Number.parseFloat(ruleTrigger ? getComputedStyle(ruleTrigger).fontSize : '0'),
      volatilityContained: contained(disclosure, weeks) && contained(weekSummary, disclosure),
    };
  });
  if (
    !state.evidenceFloor ||
    state.ruleTriggerHeight < 24 ||
    state.ruleTriggerFont < 14 ||
    !state.chartContained ||
    !state.volatilityContained ||
    state.chartBars > 32 ||
    state.progressBars
  )
    throw new Error(`Trajectory evidence/control floor mismatch: ${JSON.stringify(state)}`);
  if (
    state.mobile &&
    (state.emptyPaidVisible ||
      state.guideOpen ||
      state.referenceOpen ||
      state.priorityCards !== 3 ||
      state.priorityVisible !== 3)
  ) {
    throw new Error(`Trajectory mobile hierarchy mismatch: ${JSON.stringify(state)}`);
  }
  if (!state.mobile && (state.guideOpen || state.referenceOpen))
    throw new Error(`Trajectory secondary evidence is expanded: ${JSON.stringify(state)}`);
}
async function verifyInventory(page) {
  await assertWorkspaceLandmarks(page, [
    'inventory-overview',
    'inventory-actions',
    'inventory-controls',
    'inventory-records',
    'inventory-evidence',
  ]);
  await wait(page, '#rows tr');
  await verifyCompactLead(page, '[data-dpp-qa="inventory-actions"]');
  const tableContainment = await page.evaluate(() => {
    const scroll = document.querySelector('.inventory-shell .data-table-scroll');
    const table = document.querySelector('.inventory-table');
    const scrollRect = scroll?.getBoundingClientRect();
    const tableRect = table?.getBoundingClientRect();
    const assistiveHidden = element => {
      let ancestor = element;
      while (ancestor && ancestor !== document.documentElement) {
        const style = getComputedStyle(ancestor);
        if (
          style.clip === 'rect(0px, 0px, 0px, 0px)' ||
          style.clipPath === 'inset(50%)'
        ) return true;
        ancestor = ancestor.parentElement;
      }
      return false;
    };
    const requiresNoScroll = window.innerWidth >= 1180;
    const overflowing = scroll && scrollRect && requiresNoScroll ? [...scroll.querySelectorAll('*')]
      .filter(element =>
        !assistiveHidden(element) && element.getBoundingClientRect().right > scrollRect.right + 2
      )
      .slice(0, 5)
      .map(element => ({
        element: element.tagName.toLowerCase(),
        className: element.className || '',
        text: (element.textContent || '').trim().slice(0, 40),
        right: Math.round(element.getBoundingClientRect().right),
      })) : [];
    return {
      contained: Boolean(
        scroll && table &&
        scrollRect.right <= window.innerWidth + 2 &&
        (!requiresNoScroll || (
          scroll.scrollWidth <= scroll.clientWidth + 2 &&
          tableRect.right <= scrollRect.right + 2
        )) &&
        overflowing.length === 0
      ),
      scrollClientWidth: scroll?.clientWidth || 0,
      scrollWidth: scroll?.scrollWidth || 0,
      scrollRight: scrollRect?.right || 0,
      tableRight: tableRect?.right || 0,
      requiresNoScroll,
      overflowing,
    };
  });
  if (!tableContainment.contained)
    throw new Error(`Inventory table introduces unintended horizontal scrolling: ${JSON.stringify(tableContainment)}`);
  if ((await page.evaluate(() => window.innerWidth)) > 640) return;

  const contract = await page.evaluate(async () => {
    const payload = await (await fetch('/api/inventory', { cache: 'no-store' })).json();
    const expected = (payload.rows || []).filter(row => row.is_default_inventory).length;
    const expectedExceptions = (payload.rows || []).filter(row =>
      row.is_default_inventory && ['STOCKOUT', 'PRODUCE', 'PLAN'].includes(row.action)
    ).length;
    const rows = [...document.querySelectorAll('#rows tr')];
    const actions = document.querySelector('[data-dpp-qa="inventory-actions"]');
    const records = document.querySelector('[data-dpp-qa="inventory-records"]');
    const firstRecord = rows[0];
    const coverage = document.querySelector('#coverageMap');
    const scroll = document.querySelector('.inventory-shell .data-table-scroll');
    const requiredLabels = [
      'Lifecycle', 'Canonical SKU', 'Action', 'Available', 'Inbound', 'Reserved',
      '28D order units', 'Days cover', 'Status',
    ];
    return {
      expected,
      rendered: rows.length,
      visible: rows.filter(row => row.getBoundingClientRect().height > 0).length,
      singleRenderer: !document.getElementById('inventoryCards'),
      complete: rows.every(row => {
        const labels = [...row.querySelectorAll('td[data-label]')].map(cell => cell.dataset.label);
        return row.querySelector('th[scope="row"]') &&
          requiredLabels.every(label => labels.includes(label));
      }),
      tableVisible: document.querySelector('.inventory-table')?.getBoundingClientRect().height > 0,
      queueState: actions?.dataset.queueState || '',
      queueCount: Number(actions?.dataset.queueCount || 0),
      expectedExceptions,
      actionHeight: Math.round(actions?.getBoundingClientRect().height || 0),
      recordsTop: Math.round(records?.getBoundingClientRect().top + window.scrollY),
      firstRecordTop: Math.round(firstRecord?.getBoundingClientRect().top + window.scrollY),
      documentHeight: document.documentElement.scrollHeight,
      coverageOpen: Boolean(coverage?.open),
      coverageSummaryVisible: Boolean(coverage?.querySelector('summary')?.getClientRects().length),
      internalTableScroll: Boolean(scroll && scroll.scrollWidth > scroll.clientWidth + 2),
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  if (
    contract.rendered !== contract.expected ||
    contract.visible !== contract.expected ||
    !contract.singleRenderer ||
    !contract.complete ||
    !contract.tableVisible ||
    contract.queueCount !== contract.expectedExceptions ||
    contract.queueState !== (contract.expectedExceptions ? 'exceptions' : 'clear') ||
    contract.coverageOpen !== Boolean(contract.expectedExceptions) ||
    !contract.coverageSummaryVisible ||
    !contract.internalTableScroll ||
    contract.pageOverflow > 1 ||
    contract.documentHeight > 3400 ||
    (!contract.expectedExceptions && (
      contract.actionHeight > 190 ||
      contract.recordsTop > 600 ||
      contract.firstRecordTop > 900
    ))
  ) throw new Error(`Inventory responsive table mismatch: ${JSON.stringify(contract)}`);
}

async function assertFinanceChartMarks(page, label) {
  await wait(page, '#progression');
  const marks = await page.locator('#progression rect, #progression path, #progression line').count();
  if (!marks) throw new Error(`Finance ${label} rendered without chart marks`);
}

async function chooseClosedFinanceMonth(page) {
  const monthButton = page.locator('button[data-finance-window="month"]');
  await monthButton.click();
  await page.locator('button[data-finance-window="month"][aria-selected="true"]').waitFor({ state: 'visible', timeout: 5000 });
  await wait(page, '#monthPicker');
  const options = await page.locator('#monthPicker option').evaluateAll(items => items.map(item => ({ value: item.value, text: item.textContent || '' })));
  if (!options.length) throw new Error('Finance Month view has no accounting-month options');
  const closedOption = options.find(option => !option.text.includes('OPEN'));
  if (!closedOption) throw new Error('Finance Month view has no closed month available for immutable drill-down QA');
  await page.locator('#monthPicker').selectOption(closedOption.value);
  await assertFinanceChartMarks(page, 'closed month');
  const closedState = (await page.locator('#progressionState').textContent() || '').trim();
  if (!closedState || closedState.includes('OPEN')) throw new Error(`Finance closed-month drill-down has invalid state: ${closedState || 'blank'}`);
}

async function financeChartLayout(page) {
  return page.evaluate(() => {
    const card = document.querySelector('.finance-progression');
    const labels = [...document.querySelectorAll('#progression text')]
      .filter((node) => node.getClientRects().length > 0 && node.textContent.trim())
      .map((node) => ({ text: node.textContent.trim(), rect: node.getBoundingClientRect() }));
    const overlaps = [];
    for (let index = 0; index < labels.length; index += 1) {
      for (let next = index + 1; next < labels.length; next += 1) {
        const left = labels[index];
        const right = labels[next];
        const overlapX = Math.min(left.rect.right, right.rect.right) - Math.max(left.rect.left, right.rect.left);
        const overlapY = Math.min(left.rect.bottom, right.rect.bottom) - Math.max(left.rect.top, right.rect.top);
        if (overlapX > 1 && overlapY > 1) overlaps.push([left.text, right.text]);
      }
    }
    return { height: card?.getBoundingClientRect().height || 0, overlaps };
  });
}

async function verifyFinanceWindows(page) {
  const buttons = ['month', '3m', 'ytd', '12m', 'lastYear', 'all'];
  const mobile = (await page.evaluate(() => window.innerWidth)) <= 640;
  const layouts = [];
  for (const windowKey of buttons) {
    const button = page.locator(`button[data-finance-window="${windowKey}"]`);
    await button.waitFor({ state: 'visible', timeout: 5000 });
    await button.click();
    await page.locator(`button[data-finance-window="${windowKey}"][aria-selected="true"]`).waitFor({ state: 'visible', timeout: 5000 });
    await assertFinanceChartMarks(page, windowKey);
    layouts.push({ windowKey, ...(await financeChartLayout(page)) });
  }

  const collisions = layouts.filter((layout) => layout.overlaps.length);
  if (collisions.length) {
    throw new Error(`Finance window label collisions: ${JSON.stringify(collisions)}`);
  }

  if (mobile) {
    const heights = layouts.map((layout) => layout.height);
    const heightSpread = Math.max(...heights) - Math.min(...heights);
    if (heightSpread > 2) {
      throw new Error(`Finance mobile window layout shifts: ${JSON.stringify(layouts)}`);
    }
  }

  await chooseClosedFinanceMonth(page);

  await page.locator('button[data-finance-window="ytd"]').click();
  await page.locator('button[data-finance-window="ytd"][aria-selected="true"]').waitFor({ state: 'visible', timeout: 5000 });
  const monthBar = page.locator('#progression [data-month]').first();
  await monthBar.waitFor({ state: 'visible', timeout: 5000 });
  await monthBar.click();
  await page.locator('button[data-finance-window="month"][aria-selected="true"]').waitFor({ state: 'visible', timeout: 5000 });
  await wait(page, '#monthPicker');
  await assertFinanceChartMarks(page, 'bar drill-down');

  // Return screenshots and downstream checks to the canonical default state.
  await page.locator('button[data-finance-window="ytd"]').click();
  await page.locator('button[data-finance-window="ytd"][aria-selected="true"]').waitFor({ state: 'visible', timeout: 5000 });
  await assertFinanceChartMarks(page, 'YTD restore');
}

async function verifyFinanceReport(page) {
  await assertWorkspaceLandmarks(page, [
    'finance-accounting-header',
    'finance-management-summary',
    'finance-accounting-overview',
    'finance-immutable-history',
  ]);
  const isMobile = (await page.evaluate(() => window.innerWidth)) <= 640;
  if (isMobile) {
    await wait(page, '#currentBridge .bridge-step');
    if (!(await page.locator('.finance-read--current-summary').isVisible())) {
      throw new Error('Finance mobile hides the current-month management comparison');
    }
    const overviewDisclosure = page.locator('#financeOverviewDisclosure');
    await overviewDisclosure.waitFor({ state: 'visible', timeout: 5000 });
    if (await overviewDisclosure.getAttribute('open')) {
      throw new Error('Finance mobile accounting detail is open by default');
    }
    if (await page.locator('[data-dpp-qa="finance-accounting-overview"]').isVisible()) {
      throw new Error('Finance mobile accounting detail renders while its disclosure is closed');
    }
    const cashDisclosure = page.locator('#cashSettlementDisclosure');
    await cashDisclosure.waitFor({ state: 'visible', timeout: 5000 });
    if (await cashDisclosure.getAttribute('open')) {
      throw new Error('Finance mobile settlement evidence is open by default');
    }
    await wait(page, '#cashSettlementSummary');
  } else {
    await wait(page, '#currentLines .finance-line');
    await wait(page, '#currentBridge .bridge-step');
  }
  await wait(page, '#ytdBridge .bridge-step');
  await assertFinanceChartMarks(page, 'progression');
  await verifyFinanceWindows(page);
  // Mobile presents rows as cards while retaining the native table header for
  // assistive-technology relationships.
  await wait(page, '#history .history-row:not(.head)');
  const state = await page.evaluate(() => {
    const visible = node => node.getClientRects().length > 0;
    const evidence = [...document.querySelectorAll(
      '.finance-head .kicker,.finance-head p,.period-meta,.section-label,.eyebrow,.cell-note,.finance-line__note,.rail-row span,.state-pill,.state-row p,.finance-read__sub,.finance-read__state,.bridge-step span,.finance-chart-axis,.finance-chart-month,.chart-legend,.pending-row small,.pending-badge,.pending-metric span,.history-row,.history-row small,.history-state,.event-row small'
    )].filter(visible);
    const controls = [...document.querySelectorAll(
      '.finance-page .segmented-control__item,.finance-page #monthPicker,.state-explainer summary,.finance-mobile-disclosure > summary,.history-toggle,.finance-evidence summary'
    )].filter(visible);
    const mobile = window.innerWidth <= 640;
    const tableHead = document.querySelector('#history thead');
    const ytdFinal = document.querySelector('#ytdBridge .bridge-step.final');
    const ytdFinalValue = ytdFinal?.querySelector('strong');
    const managementSummary = document.querySelector('[data-dpp-qa="finance-management-summary"]');
    const currentSummary = document.querySelector('.finance-read--current-summary');
    const closedYtd = document.querySelector('#ytdBridge')?.closest('.finance-read');
    const accountingDisclosure = document.getElementById('financeOverviewDisclosure');
    const accountingOverview = document.querySelector('[data-dpp-qa="finance-accounting-overview"]');
    const evidenceDetails = document.querySelector('.finance-evidence details');
    return {
      evidenceFloor: evidence.every(node => Number.parseFloat(getComputedStyle(node).fontSize) >= 14),
      controlFloor: controls.every(node => node.getBoundingClientRect().height >= 40),
      mobileHeaderAvailable: !mobile || (tableHead && getComputedStyle(tableHead).display !== 'none'),
      tableRelationships:
        document.querySelectorAll('#history thead th[scope="col"]').length === 8 &&
        document.querySelectorAll('#history tbody tr').length === document.querySelectorAll('#history tbody th[scope="row"]').length,
      anchoredSections: document.querySelectorAll('.finance-page h2').length >= 7,
      ytdResultTone: Boolean(
        ytdFinal &&
          ytdFinalValue &&
          (!ytdFinalValue.classList.contains('neg') || ytdFinal.classList.contains('negative'))
      ),
      managementFirst:
        Boolean(managementSummary && currentSummary && closedYtd && accountingDisclosure) &&
        managementSummary.getBoundingClientRect().top < accountingDisclosure.getBoundingClientRect().top,
      mobileComparisonBudget:
        !mobile ||
        (currentSummary.getBoundingClientRect().top < window.innerHeight &&
          closedYtd.getBoundingClientRect().top <= window.innerHeight + 120 &&
          !accountingDisclosure.hasAttribute('open') &&
          accountingOverview.getClientRects().length === 0),
      accountingEvidenceBound: Boolean(
        evidenceDetails &&
        Number.parseFloat(getComputedStyle(evidenceDetails).borderTopWidth) >= 1 &&
        getComputedStyle(evidenceDetails).overflow === 'hidden'
      ),
    };
  });
  if (!state.evidenceFloor || !state.controlFloor || !state.mobileHeaderAvailable || !state.tableRelationships || !state.anchoredSections || !state.ytdResultTone || !state.managementFirst || !state.mobileComparisonBudget || !state.accountingEvidenceBound) {
    throw new Error(`Finance hierarchy/accessibility presentation mismatch: ${JSON.stringify(state)}`);
  }
}

async function verifyFinanceClosed(page) {
  await verifyFinanceReport(page);
  await chooseClosedFinanceMonth(page);
}

async function verifyFinanceEvidence(page) {
  await verifyFinanceReport(page);
  const evidence = page.locator('.finance-evidence details').first();
  await evidence.waitFor({ state: 'visible', timeout: 5000 });
  await evidence.locator('summary').click();
  await wait(page, '#events .event-row');
}

async function verifySalesOrders(page) {
  await page.locator('button[data-view="products"]').click();
  const evidence = page.locator('#orderEvidence');
  await evidence.locator('summary').click();
  await wait(page, '#orderRows tr');
  const state = await page.evaluate(async () => {
    const payload = await (await fetch('/api/sales', { cache: 'no-store' })).json();
    const rows = [...document.querySelectorAll('#orderRows tr')];
    const apiOrders = Array.isArray(payload.orders) ? payload.orders : [];
    const control = document.getElementById('ordersMore');
    const mobile = window.innerWidth <= 720;
    return {
      mobile,
      total: rows.length,
      visible: rows.filter(row => getComputedStyle(row).display !== 'none').length,
      controlVisible: Boolean(control && getComputedStyle(control).display !== 'none'),
      expanded: control?.getAttribute('aria-expanded'),
      evidenceOpen: Boolean(document.getElementById('orderEvidence')?.hasAttribute('open')),
      orderGap: Number.parseFloat(
        getComputedStyle(document.getElementById('orderRows')).rowGap || '0'
      ),
      cardBoundaries: rows.every(row => {
        const style = getComputedStyle(row);
        return (
          !mobile ||
          (
            Number.parseFloat(style.borderTopWidth) >= 1 &&
            Number.parseFloat(style.borderTopLeftRadius) >= 12 &&
            style.boxShadow !== 'none'
          )
        );
      }),
      headerHierarchy: rows.every(row => {
        const rowStyle = getComputedStyle(row);
        const headerStyle = getComputedStyle(row.children[0]);
        return (
          !mobile ||
          (
            headerStyle.backgroundColor === rowStyle.backgroundColor &&
            headerStyle.boxShadow !== 'none'
          )
        );
      }),
      orderLabels: rows.every(
        row =>
          row.querySelector('.order-moment__label')?.textContent?.trim() === 'Order' &&
          row.querySelector('.order-status-cell__label')?.textContent?.trim() === 'Fulfillment'
      ),
      structured: rows.every(row =>
        row.querySelector('.order-moment') &&
        row.querySelector('.sales-order-items') &&
        row.querySelector('.order-spend') &&
        row.querySelector('.order-status-pill')
      ),
      itemRows: document.querySelectorAll('.sales-order-item').length,
      namedItems: [...document.querySelectorAll('.sales-order-item strong')]
        .every(item => item.textContent.trim().length > 0),
      multiItemOrders: apiOrders.filter(
        order => Array.isArray(order.order_items) && order.order_items.length > 1
      ).length,
      itemContracts: rows.map((row, index) => {
        const expected = Array.isArray(apiOrders[index]?.order_items)
          ? apiOrders[index].order_items
          : [];
        const rendered = [...row.querySelectorAll('.sales-order-item')];
        const renderedNames = rendered.map(
          item => item.querySelector('strong')?.textContent?.trim() || ''
        );
        const expectedNames = expected.map(item =>
          String(item.product || item.sku || item.asin || 'Item').trim()
        );
        const quantitiesMatch = rendered.every(
          (item, itemIndex) =>
            item.querySelector('b')?.textContent?.trim() ===
            `×${Number(expected[itemIndex]?.quantity_ordered ?? expected[itemIndex]?.quantity ?? 0).toLocaleString('en-US')}`
        );
        const thumbnailsMatch = rendered.every((item, itemIndex) =>
          expected[itemIndex]?.image_url
            ? Boolean(item.querySelector('img'))
            : Boolean(item.querySelector('.sales-order-item__placeholder'))
        );
        return {
          order: apiOrders[index]?.order_short || '',
          expected: expected.length,
          rendered: rendered.length,
          namesMatch: JSON.stringify(renderedNames) === JSON.stringify(expectedNames),
          quantitiesMatch,
          thumbnailsMatch,
          fallbackVisible: Boolean(row.querySelector('.sales-order-items__empty')),
        };
      }),
      statuses: rows.map(row => row.querySelector('.order-status-pill')?.textContent?.trim() || ''),
    };
  });
  if (!state.evidenceOpen || !state.structured || !state.itemRows || !state.namedItems) {
    throw new Error(`Sales Orders structure mismatch: ${JSON.stringify(state)}`);
  }
  if (
    state.mobile &&
    (
      !state.cardBoundaries ||
      !state.headerHierarchy ||
      state.orderGap < 16 ||
      !state.orderLabels
    )
  ) {
    throw new Error(`Sales Orders mobile boundaries mismatch: ${JSON.stringify(state)}`);
  }
  const brokenItems = state.itemContracts.filter(
    contract =>
      contract.expected !== contract.rendered ||
      !contract.namesMatch ||
      !contract.quantitiesMatch ||
      !contract.thumbnailsMatch ||
      (contract.expected > 0 && contract.fallbackVisible)
  );
  if (brokenItems.length) {
    throw new Error(
      `Sales Orders item contract mismatch: ${JSON.stringify(brokenItems.slice(0, 5))}`
    );
  }
  if (!state.multiItemOrders) {
    throw new Error('Sales Orders QA has no multi-item order to verify');
  }
  if (
    state.mobile &&
    state.total > 10 &&
    (state.visible !== 10 || !state.controlVisible || state.expanded !== 'false')
  ) {
    throw new Error(`Sales Orders mobile density mismatch: ${JSON.stringify(state)}`);
  }
  if (!state.mobile && state.visible !== state.total) {
    throw new Error(`Sales Orders desktop rows hidden: ${JSON.stringify(state)}`);
  }
  const leakedPending = state.statuses.filter(status => /\bpending(?:_availability)?\b/i.test(status));
  if (leakedPending.length) {
    throw new Error(`Sales Orders leaked raw pending language: ${JSON.stringify(leakedPending)}`);
  }
}

const scenarios = [
  ['today', '/', ['mobile', 'tablet', 'desktop', 'wide'], verifyToday],
  ['today-wall', '/?wall=1', ['desktop']],
  ['business', '/business', ['mobile', 'tablet', 'desktop', 'wide'], verifyBusiness],
  ['sales-overview', '/sales', ['mobile', 'tablet', 'desktop'], verifySalesOverview],
  ['sales-header-boundary', '/sales', ['sales619', 'sales620', 'sales621', 'sales639', 'sales640', 'sales641'], verifySalesChartHeader],
  ['sales-products', '/sales', ['mobile', 'desktop'], verifySalesProducts],
  ['sales-orders', '/sales', ['mobile', 'desktop'], verifySalesOrders],
  ['sales-geography', '/sales?view=geography', ['mobile', 'desktop'], verifySalesGeography],
  ['catalog', '/catalog', ['mobile', 'tablet', 'desktop'], verifyCatalog],
  ['catalog-design', '/catalog', ['mobile', 'desktop'], p => verifyCatalogMode(p, 'dimension:design')],
  ['catalog-ruling', '/catalog', ['mobile', 'desktop'], p => verifyCatalogMode(p, 'dimension:ruling')],
  ['catalog-combinations', '/catalog', ['mobile', 'desktop'], p => verifyCatalogMode(p, 'pair')],
  ['catalog-sku', '/catalog', ['mobile', 'desktop'], p => verifyCatalogMode(p, 'sku')],
  ['product-missing-sku', '/product', ['mobile', 'desktop'], verifyProductMissingSku],
  ['product-pnc-001', '/product?sku=PNC-001', ['mobile', 'desktop'], verifyProductWorkspace],
  ['product-zero-demand', '/product?sku=PNC-001L', ['desktop'], verifyProductZeroDemand, mockProductZeroDemand],
  ['inventory', '/inventory', ['mobile', 'tablet', 'desktop'], verifyInventory],
  ['ads-overview', '/ads', ['mobile', 'tablet', 'desktop'], p => verifyAds(p)],
  ['ads-campaigns', '/ads', ['mobile', 'desktop'], p => verifyAds(p, 'campaigns')],
  ['finance-overview', '/finance', ['mobile', 'desktop'], verifyFinanceReport],
  ['finance-closed', '/finance', ['mobile', 'tablet', 'desktop'], verifyFinanceClosed],
  ['finance-ledger', '/finance', ['mobile', 'desktop'], verifyFinanceEvidence],
  ['trajectory', '/trajectory', ['mobile', 'tablet', 'desktop', 'wide'], verifyTrajectory],
  ['data-health', '/data-health', ['mobile', 'desktop', 'wide'], verifyDataHealth],
  ['admin', '/admin', ['mobile', 'desktop'], verifyAdmin],
].map(([name, url, views, action, setup]) => ({ name, url, views, action, setup }));

const presentationProfiles = [
  'warm-studio',
  'midnight-saffron',
  'aubergine-aqua',
  'midnight-dark',
  'aubergine-dark',
  'weyland',
];
const presentationRoutes = [
  ['today', '/'], ['business', '/business'], ['sales', '/sales'], ['products', '/catalog'],
  ['product', '/product?sku=PNC-001'], ['inventory', '/inventory'], ['finance', '/finance'],
  ['advertising', '/ads'], ['trajectory', '/trajectory'], ['data-health', '/data-health'],
  ['admin', '/admin'],
];
for (const [name, url] of presentationRoutes) {
  for (const profile of presentationProfiles) {
    scenarios.push({
      name: `profile-${name}-${profile}`,
      url,
      views: ['mobile', 'desktop'],
      profile,
      action: page => verifyControlTrustAppearance(page, profile),
    });
  }
}

await fs.mkdir(outDir, { recursive: true });
for (const entry of await fs.readdir(outDir)) await fs.rm(path.join(outDir, entry), { recursive: true, force: true });
const results = [];
const safeName = value => value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
const requestedBrowsers = new Set((process.env.DPP_QA_BROWSERS || 'chromium,webkit').split(',').map(value => value.trim()));
const requestedScenarios = new Set((process.env.DPP_QA_SCENARIOS || '').split(',').map(value => value.trim()).filter(Boolean));
const plannedScenarios = requestedScenarios.size ? scenarios.filter(scenario => requestedScenarios.has(scenario.name)) : scenarios;
const browserPlans = [
  { name: 'chromium', engine: chromium, scenarios: plannedScenarios },
  { name: 'webkit', engine: webkit, scenarios: plannedScenarios.filter(scenario => ['today', 'business', 'sales-header-boundary', 'trajectory', 'data-health'].includes(scenario.name)) },
].filter(plan => requestedBrowsers.has(plan.name));

for (const plan of browserPlans) {
const browser = await plan.engine.launch({ headless: true });
for (const scenario of plan.scenarios) for (const viewportName of scenario.views) {
  const viewport = viewports[viewportName];
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, isMobile: viewport.isMobile, hasTouch: viewport.hasTouch, deviceScaleFactor: 1 });
  if (scenario.profile) {
    await context.addInitScript(profileId => {
      window.localStorage.setItem(
        'dpp.presentation.v1',
        JSON.stringify({ schemaVersion: 1, profileId })
      );
    }, scenario.profile);
  }
  if (scenario.setup) await scenario.setup(context);
  const page = await context.newPage();
  const errors = [], warnings = [], failedResponses = [];
  page.on('pageerror', err => errors.push(`pageerror: ${err.message}`));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(`console: ${msg.text()}`); if (msg.type() === 'warning') warnings.push(`console: ${msg.text()}`); });
  page.on('response', async response => { if (response.status() >= 400 && response.url().startsWith(baseUrl)) failedResponses.push(`${response.status()} ${response.request().method()} ${response.url()}`); });
  const result = { browser: plan.name, scenario: scenario.name, viewport: viewportName, profile: scenario.profile || 'warm-studio', width: viewport.width, height: viewport.height, url: `${baseUrl}${scenario.url}`, screenshot: null, metrics: null, errors, warnings, failedResponses, ok: false };
  try {
    const response = await page.goto(result.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    if (!response?.ok()) throw new Error(`navigation returned ${response?.status() || 'no response'}`);
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1000);
    if (scenario.action) { await scenario.action(page); await page.waitForTimeout(500); }
    result.metrics = await page.evaluate(({ viewportName }) => {
      const visible = el => {
        const r = el.getBoundingClientRect(), s = getComputedStyle(el);
        let ancestor = el;
        let clippedForAssistiveTech = false;
        while (ancestor && ancestor !== document.documentElement) {
          const ancestorStyle = getComputedStyle(ancestor);
          if (
            ancestorStyle.clip === 'rect(0px, 0px, 0px, 0px)' ||
            ancestorStyle.clipPath === 'inset(50%)'
          ) {
            clippedForAssistiveTech = true;
            break;
          }
          ancestor = ancestor.parentElement;
        }
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' &&
          Number(s.opacity || 1) > 0 && !clippedForAssistiveTech;
      };
      const signature = element => `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${[...element.classList].slice(0, 3).map(name => `.${name}`).join('')}`;
      const hasHorizontalScrollAncestor = element => {
        let ancestor = element.parentElement;
        while (ancestor && ancestor !== document.body) {
          const style = getComputedStyle(ancestor);
          if ((style.overflowX === 'auto' || style.overflowX === 'scroll') && ancestor.scrollWidth > ancestor.clientWidth + 2) return true;
          ancestor = ancestor.parentElement;
        }
        return false;
      };
      const minFont = viewportName === 'mobile' ? 11.5 : viewportName === 'tablet' ? 10.5 : 9.5;
      const textEls = [...document.querySelectorAll('body *')].filter(el => visible(el) && !el.children.length && (el.textContent || '').trim());
      const smallText = textEls.filter(el => Number.parseFloat(getComputedStyle(el).fontSize || '0') < minFont).slice(0, 40);
      const currencyJoinViolations = textEls
        .filter(el => /\$(?=\d)/.test(el.textContent || ''))
        .slice(0, 20)
        .map(el => ({ element: signature(el), text: (el.textContent || '').trim().slice(0, 80) }));
      const clickables = [...document.querySelectorAll('a,button,[role="button"],input,select,textarea')].filter(visible);
      const smallTargets = clickables.filter(el => { const r = el.getBoundingClientRect(); return r.width < 36 || r.height < 36; }).slice(0, 40);
      const mainElements = [...document.querySelectorAll('main *')].filter(visible).filter(element => !element.closest('.sr-only'));
      const rawUncontained = mainElements.filter(element => {
        const bounds = element.getBoundingClientRect();
        return (bounds.left < -2 || bounds.right > window.innerWidth + 2) && !hasHorizontalScrollAncestor(element);
      });
      const uncontainedElements = rawUncontained.filter(element => !rawUncontained.some(parent => parent !== element && parent.contains(element))).slice(0, 20).map(element => {
        const bounds = element.getBoundingClientRect();
        return { element: signature(element), left: Math.round(bounds.left), right: Math.round(bounds.right) };
      });
      const clippedContainers = mainElements.filter(element => {
        const style = getComputedStyle(element);
        const clippedX = element.scrollWidth > element.clientWidth + 2 && (style.overflowX === 'hidden' || style.overflowX === 'clip');
        const clippedY = element.scrollHeight > element.clientHeight + 2 && (style.overflowY === 'hidden' || style.overflowY === 'clip');
        return (clippedX || clippedY) && (element.innerText || element.textContent || '').trim();
      }).slice(0, 20).map(element => ({ element: signature(element), deltaX: element.scrollWidth - element.clientWidth, deltaY: element.scrollHeight - element.clientHeight }));
      const internalScrollers = mainElements.filter(element => {
        const style = getComputedStyle(element);
        return (style.overflowX === 'auto' || style.overflowX === 'scroll') && element.scrollWidth > element.clientWidth + 2;
      }).slice(0, 20).map(element => ({ element: signature(element), deltaX: element.scrollWidth - element.clientWidth }));
      const doc = document.documentElement, body = document.body, scrollWidth = Math.max(doc.scrollWidth, body.scrollWidth);
      const main = document.querySelector('main');
      return { title: document.title, bodyTextLength: (body.innerText || '').length, activeTab: document.querySelector('.tabs button.active,.view-tabs button.active,.analysis-modes button.active')?.textContent?.trim() || null, scrollWidth, scrollHeight: Math.max(doc.scrollHeight, body.scrollHeight), horizontalOverflowPx: Math.max(0, scrollWidth - doc.clientWidth), mainViewportUse: Number(((main?.getBoundingClientRect().width || 0) / window.innerWidth).toFixed(3)), internalScrollers, uncontainedElements, clippedContainers, currencyJoinViolations, smallTextCount: smallText.length, smallTapTargetCount: smallTargets.length };
    }, { viewportName });
    if (result.metrics.currencyJoinViolations.length) errors.push(`currency symbol joins amount: ${JSON.stringify(result.metrics.currencyJoinViolations)}`);
    if (viewportName === 'mobile' && result.metrics.uncontainedElements.length) errors.push(`mobile component overflow: ${JSON.stringify(result.metrics.uncontainedElements)}`);
    if (viewportName === 'mobile' && result.metrics.clippedContainers.length) errors.push(`mobile clipped content: ${JSON.stringify(result.metrics.clippedContainers)}`);
    if (['mobile', 'wide'].includes(viewportName) && result.metrics.horizontalOverflowPx > 2) errors.push(`${viewportName} document overflow: ${result.metrics.horizontalOverflowPx}px`);
    if (viewportName === 'wide' && result.metrics.mainViewportUse < 0.82) errors.push(`wide workspace uses only ${result.metrics.mainViewportUse} of viewport width`);
    if (viewportName === 'wide' && result.metrics.internalScrollers.length) errors.push(`wide internal scrolling: ${JSON.stringify(result.metrics.internalScrollers)}`);
    const fileName = `${plan.name}-${safeName(scenario.name)}-${viewportName}.png`;
    await page.screenshot({ path: path.join(outDir, fileName), fullPage: true });
    result.screenshot = fileName;
    result.ok = !errors.length && !failedResponses.length;
  } catch (err) {
    errors.push(`qa: ${err.message}`);
    const fileName = `${plan.name}-${safeName(scenario.name)}-${viewportName}-error.png`;
    await page.screenshot({ path: path.join(outDir, fileName), fullPage: true }).catch(() => {});
    result.screenshot = fileName;
  }
  results.push(result);
  await context.close();
}
await browser.close();
}

const summary = { generatedAt: new Date().toISOString(), baseUrl, captures: results.length, successfulCaptures: results.filter(x => x.ok).length, navigationFailures: results.filter(x => !x.ok).length, consoleErrorCount: results.reduce((n, x) => n + x.errors.length, 0), failedResponseCount: results.reduce((n, x) => n + x.failedResponses.length, 0), horizontalOverflowCaptures: results.filter(x => (x.metrics?.horizontalOverflowPx || 0) > 2).length, smallTextSignals: results.reduce((n, x) => n + (x.metrics?.smallTextCount || 0), 0), smallTapTargetSignals: results.reduce((n, x) => n + (x.metrics?.smallTapTargetCount || 0), 0), results };
await fs.writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
const lines = ['# DPP Visual QA', '', `Generated: ${summary.generatedAt}`, `Base URL: ${baseUrl}`, '', `**${summary.successfulCaptures}/${summary.captures} captures succeeded.**`, '', '| Browser | Screen | Viewport | Active tab | Overflow | Small text | Small tap targets | Browser errors |', '|---|---|---:|---|---:|---:|---:|---:|'];
for (const r of results) lines.push(`| ${r.browser} | ${r.scenario} | ${r.viewport} ${r.width}×${r.height} | ${r.metrics?.activeTab ?? '—'} | ${r.metrics?.horizontalOverflowPx ?? '—'}px | ${r.metrics?.smallTextCount ?? '—'} | ${r.metrics?.smallTapTargetCount ?? '—'} | ${r.errors.length} |`);
lines.push('', '## Signals', '', `- Horizontal overflow: ${summary.horizontalOverflowCaptures} capture(s)`, `- Small-text signals: ${summary.smallTextSignals}`, `- Small tap-target signals: ${summary.smallTapTargetSignals}`, `- Failed local HTTP responses: ${summary.failedResponseCount}`, `- Browser/page errors: ${summary.consoleErrorCount}`, '', '_Screenshots remain the source of truth for visual judgment._', '');
await fs.writeFile(path.join(outDir, 'report.md'), lines.join('\n'));
console.log(JSON.stringify({ captures: summary.captures, successful: summary.successfulCaptures, navigationFailures: summary.navigationFailures, overflowCaptures: summary.horizontalOverflowCaptures, smallTextSignals: summary.smallTextSignals, smallTapTargetSignals: summary.smallTapTargetSignals, failedResponses: summary.failedResponseCount, browserErrors: summary.consoleErrorCount }, null, 2));
if (summary.navigationFailures || summary.consoleErrorCount || summary.failedResponseCount) process.exitCode = 2;
