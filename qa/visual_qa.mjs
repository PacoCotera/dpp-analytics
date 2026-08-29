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

async function verifyControlTrustAppearance(page, expectedProfile) {
  await wait(page, 'main');
  await page.waitForFunction(() => {
    if (document.body.classList.contains('finance-page')) return Boolean(document.querySelector('#currentLines .finance-line'));
    if (document.body.classList.contains('ads-page')) return !document.getElementById('readyState')?.hidden || !document.getElementById('emptyState')?.hidden;
    if (document.body.classList.contains('data-health-page')) return document.getElementById('summaryCount')?.textContent?.trim() !== '—';
    if (document.body.classList.contains('admin-shell')) return Boolean(document.getElementById('loginPanel'));
    return false;
  }, null, { timeout: 10000 });
  const state = await page.evaluate(profileId => {
    const root = document.documentElement;
    const css = getComputedStyle(root);
    const visible = node => node.getClientRects().length > 0;
    const surfaces = [...document.querySelectorAll(
      '.admin-login,.product-editor,.ads-quality,.ads-action-card,.health-summary,.incident,.domain-summary,.source,.bridge-step,.pending-row,.history-row'
    )].filter(visible);
    const channelMax = color => {
      const channels = String(color).match(/[\d.]+/g)?.slice(0, 3).map(Number) || [];
      return channels.length ? Math.max(...channels) : 0;
    };
    const controls = [...document.querySelectorAll('main button,main input,main select,main summary')].filter(visible);
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
    (expectedProfile === 'weyland' && state.profile !== 'weyland')
  ) {
    throw new Error(`Control/trust ${expectedProfile} appearance mismatch: ${JSON.stringify(state)}`);
  }
}

async function verifyAdmin(page) {
  await wait(page, '#loginPanel');
  const state = await page.evaluate(() => {
    const visible = node => node.getClientRects().length > 0;
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
        explained: Boolean(note && !note.hidden && note.textContent.includes(connectionDetail || '')),
        contained: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2,
      };
    }, payload.connection?.detail || '');
    if (!disconnected.overviewEnabled || !disconnected.drillsDisabled || !disconnected.explained || !disconnected.contained) {
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
    };
  });
  if (
    state.ruleTriggerHeight < 24 ||
    state.ruleTriggerFont < 14 ||
    state.todayLinkHeight < 24 ||
    state.todayLinkFont < 14
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
    const rhythmKpis = [...document.querySelectorAll('.rhythm-kpi')];
    const tops = rhythmKpis.map(item => Math.round(item.getBoundingClientRect().top));
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
    };
  });
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

async function verifyBusiness(page) {
  await wait(page, '#stateHeadline');
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
          main.querySelector('h1')?.textContent?.trim() === expectedHeadline &&
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
    !state.adsAfterHealth
  ) {
    throw new Error(`Business decision-board contract mismatch: ${JSON.stringify(state)}`);
  }
}
async function verifyDataHealth(page) {
  await assertWorkspaceLandmarks(page, ['data-health-overview', 'catalog-onboarding']);
  await wait(page, '.health-summary');
  await wait(page, '#jobs .health-job');
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
      mobilePipelineMetrics:
        window.innerWidth > 640 ||
        ([...document.querySelectorAll('#jobs .health-job')].length === jobs.length &&
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
    state.renderedJobs !== state.jobs ||
    state.syncActions !== state.jobs ||
    state.toggleExpanded !== 'true' ||
    state.toggleCopy !== 'Problems only' ||
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
    !state.mobileHeaderAvailable ||
    !state.evidenceFloor ||
    !state.controlFloor ||
    !state.refreshCopy.includes('refreshes every 60s') ||
    state.attentionVisible !== Boolean(state.problems) ||
    state.incidents !== state.problems ||
    (state.problems > 0 && !state.incidentStructure)
  ) {
    throw new Error(`Data Health diagnostic contract mismatch: ${JSON.stringify(state)}`);
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
  await assertWorkspaceLandmarks(page, [
    'catalog-overview',
    'catalog-decisions',
    'catalog-controls',
    'catalog-evidence',
  ]);
  await page.locator('.family').first().waitFor({ state: 'visible', timeout: 15000 });
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
      const economics = summary?.querySelector(':scope > .economics');
      return {
        duplicateTitleVisible: Boolean(
          document.querySelector('.catalog-title') &&
            getComputedStyle(document.querySelector('.catalog-title')).display !== 'none',
        ),
        economicsVisible: Boolean(economics && getComputedStyle(economics).display !== 'none'),
        metricCount: metrics.length,
        metricTopSpread: tops.length ? Math.max(...tops) - Math.min(...tops) : null,
      };
    });
    if (mobile.duplicateTitleVisible) throw new Error('Catalog mobile repeats the portfolio title');
    if (mobile.economicsVisible) throw new Error('Catalog mobile exposes desktop economics in the family summary');
    if (mobile.metricCount !== 3 || mobile.metricTopSpread > 2)
      throw new Error(
        `Catalog mobile metrics are not a compact three-column strip: ${mobile.metricCount} / ${mobile.metricTopSpread}`,
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
    return {
      mobile: window.innerWidth <= 720,
      total: rows.length,
      visible: rows.filter((row) => row.getClientRects().length > 0).length,
      disclosure: Boolean(disclosure),
      disclosureOpen: Boolean(disclosure?.hasAttribute('open')),
    };
  });
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
    const facts = document.querySelector('.product-health__facts');
    const decisions = document.querySelector('.decision-rail');
    const chart = document.querySelector('.product-chart-panel');
    const summary = reference?.querySelector(':scope > summary');
    return {
      mobile,
      referenceOpen: Boolean(reference?.hasAttribute('open')),
      factsVisible: Boolean(facts && window.getComputedStyle(facts).display !== 'none'),
      decisionsAfterChart: Boolean(
        decisions && chart && decisions.getBoundingClientRect().top >= chart.getBoundingClientRect().top
      ),
      referenceSummaryHeight: summary?.getBoundingClientRect().height || 0,
      catalogTitleVisible: Boolean(
        document.querySelector('.hero-catalog-title')?.getBoundingClientRect().height,
      ),
      metricControls: document.querySelectorAll('[data-metric]').length,
    };
  });
  if (
    mobileHierarchy.mobile &&
    (mobileHierarchy.referenceOpen ||
      mobileHierarchy.factsVisible ||
      !mobileHierarchy.decisionsAfterChart ||
      !mobileHierarchy.catalogTitleVisible ||
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
    };
  });
  if (
    !state.evidenceFloor ||
    state.ruleTriggerHeight < 24 ||
    state.ruleTriggerFont < 14 ||
    !state.chartContained ||
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
  if ((await page.evaluate(() => window.innerWidth)) > 640) {
    await wait(page, '#rows tr');
    return;
  }
  await wait(page, '#inventoryCards .inv-card');

  const contract = await page.evaluate(async () => {
    const payload = await (await fetch('/api/inventory', { cache: 'no-store' })).json();
    const holdCount = (payload.rows || []).filter((row) => row.action === 'HOLD').length;
    const details = document.querySelector('.inventory-reference');
    return {
      holdCount,
      hasDetails: Boolean(details),
      detailsOpen: Boolean(details?.open),
      visibleReferenceCards: [...document.querySelectorAll('.inv-card--reference')].filter(
        (element) => element.getBoundingClientRect().height > 0,
      ).length,
    };
  });

  if (contract.holdCount && !contract.hasDetails)
    throw new Error('Inventory mobile default is missing collapsed reference inventory');
  if (contract.detailsOpen || contract.visibleReferenceCards)
    throw new Error('Inventory mobile default exposes the no-velocity reference wall');
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

async function verifyFinanceWindows(page) {
  const buttons = ['3m', 'ytd', '12m', 'lastYear', 'all'];
  for (const windowKey of buttons) {
    const button = page.locator(`button[data-finance-window="${windowKey}"]`);
    await button.waitFor({ state: 'visible', timeout: 5000 });
    await button.click();
    await page.locator(`button[data-finance-window="${windowKey}"][aria-selected="true"]`).waitFor({ state: 'visible', timeout: 5000 });
    await assertFinanceChartMarks(page, windowKey);
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
    'finance-accounting-overview',
    'finance-immutable-history',
  ]);
  await wait(page, '#currentLines .finance-line');
  const isMobile = (await page.evaluate(() => window.innerWidth)) <= 640;
  if (isMobile) {
    if (await page.locator('.finance-read--current-summary').isVisible()) {
      throw new Error('Finance mobile repeats the current-month contribution summary');
    }
    const cashDisclosure = page.locator('#cashSettlementDisclosure');
    await cashDisclosure.waitFor({ state: 'visible', timeout: 5000 });
    if (await cashDisclosure.getAttribute('open')) {
      throw new Error('Finance mobile settlement evidence is open by default');
    }
    await wait(page, '#cashSettlementSummary');
  } else {
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
    return {
      evidenceFloor: evidence.every(node => Number.parseFloat(getComputedStyle(node).fontSize) >= 14),
      controlFloor: controls.every(node => node.getBoundingClientRect().height >= 40),
      mobileHeaderAvailable: !mobile || (tableHead && getComputedStyle(tableHead).display !== 'none'),
      tableRelationships:
        document.querySelectorAll('#history thead th[scope="col"]').length === 8 &&
        document.querySelectorAll('#history tbody tr').length === document.querySelectorAll('#history tbody th[scope="row"]').length,
      anchoredSections: document.querySelectorAll('.finance-page h2').length >= 7,
    };
  });
  if (!state.evidenceFloor || !state.controlFloor || !state.mobileHeaderAvailable || !state.tableRelationships || !state.anchoredSections) {
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
  ['today', '/', ['mobile', 'desktop', 'wide'], verifyToday],
  ['today-wall', '/?wall=1', ['desktop']],
  ['business', '/business', ['mobile', 'tablet', 'desktop', 'wide'], verifyBusiness],
  ['sales-overview', '/sales', ['mobile', 'tablet', 'desktop'], verifySalesOverview],
  ['sales-products', '/sales', ['mobile', 'desktop'], verifySalesProducts],
  ['sales-orders', '/sales', ['mobile', 'desktop'], verifySalesOrders],
  ['catalog', '/catalog', ['mobile', 'tablet', 'desktop'], verifyCatalog],
  ['catalog-design', '/catalog', ['mobile', 'desktop'], p => verifyCatalogMode(p, 'dimension:design')],
  ['catalog-ruling', '/catalog', ['mobile', 'desktop'], p => verifyCatalogMode(p, 'dimension:ruling')],
  ['catalog-combinations', '/catalog', ['mobile', 'desktop'], p => verifyCatalogMode(p, 'pair')],
  ['catalog-sku', '/catalog', ['mobile', 'desktop'], p => verifyCatalogMode(p, 'sku')],
  ['product-pnc-001', '/product?sku=PNC-001', ['mobile', 'desktop'], verifyProductWorkspace],
  ['product-zero-demand', '/product?sku=PNC-001L', ['desktop'], verifyProductZeroDemand, mockProductZeroDemand],
  ['inventory', '/inventory', ['mobile', 'tablet', 'desktop'], verifyInventory],
  ['ads-overview', '/ads', ['mobile', 'tablet', 'desktop'], p => verifyAds(p)],
  ['ads-campaigns', '/ads', ['mobile', 'desktop'], p => verifyAds(p, 'campaigns')],
  ['finance-overview', '/finance', ['mobile', 'desktop'], verifyFinanceReport],
  ['finance-closed', '/finance', ['mobile', 'tablet', 'desktop'], verifyFinanceClosed],
  ['finance-ledger', '/finance', ['mobile', 'desktop'], verifyFinanceEvidence],
  ['trajectory', '/trajectory', ['mobile', 'desktop', 'wide'], verifyTrajectory],
  ['data-health', '/data-health', ['mobile', 'desktop', 'wide'], verifyDataHealth],
  ['admin', '/admin', ['mobile', 'desktop'], verifyAdmin],
].map(([name, url, views, action, setup]) => ({ name, url, views, action, setup }));

const financeProfiles = [
  'warm-studio',
  'midnight-saffron',
  'aubergine-aqua',
  'midnight-dark',
  'aubergine-dark',
  'weyland',
];
for (const profile of financeProfiles) {
  scenarios.push({
    name: `finance-${profile}`,
    url: '/finance',
    views: ['mobile', 'desktop'],
    profile,
    action: page => verifyControlTrustAppearance(page, profile),
  });
}
for (const [name, url] of [['ads', '/ads'], ['data-health', '/data-health'], ['admin', '/admin']]) {
  for (const profile of ['midnight-dark', 'weyland']) {
    scenarios.push({
      name: `${name}-${profile}`,
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
  { name: 'webkit', engine: webkit, scenarios: plannedScenarios.filter(scenario => ['today', 'business', 'trajectory', 'data-health'].includes(scenario.name)) },
].filter(plan => requestedBrowsers.has(plan.name));

for (const plan of browserPlans) {
const browser = await plan.engine.launch({ headless: true });
for (const scenario of plan.scenarios) for (const viewportName of scenario.views) {
  if (plan.name === 'webkit' && !['mobile', 'desktop', 'wide'].includes(viewportName)) continue;
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
        const clippedForAssistiveTech =
          s.clip === 'rect(0px, 0px, 0px, 0px)' || s.clipPath === 'inset(50%)';
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
      return { title: document.title, bodyTextLength: (body.innerText || '').length, activeTab: document.querySelector('.tabs button.active,.view-tabs button.active,.analysis-modes button.active')?.textContent?.trim() || null, scrollWidth, scrollHeight: Math.max(doc.scrollHeight, body.scrollHeight), horizontalOverflowPx: Math.max(0, scrollWidth - doc.clientWidth), mainViewportUse: Number(((main?.getBoundingClientRect().width || 0) / window.innerWidth).toFixed(3)), internalScrollers, uncontainedElements, clippedContainers, smallTextCount: smallText.length, smallTapTargetCount: smallTargets.length };
    }, { viewportName });
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
