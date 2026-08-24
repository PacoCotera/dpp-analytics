import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const baseUrl = (process.argv[2] || 'http://127.0.0.1:8088').replace(/\/$/, '');
const outDir = process.argv[3] || '/out';
const viewports = {
  mobile: { width: 412, height: 915, isMobile: true, hasTouch: true },
  tablet: { width: 1024, height: 768, isMobile: false, hasTouch: true },
  desktop: { width: 1600, height: 1000, isMobile: false, hasTouch: false },
};
const wait = (page, selector) => page.locator(selector).first().waitFor({ state: 'visible', timeout: 5000 });

async function verifyAds(page, view = 'overview') {
  const status = await page.evaluate(async () => (await (await fetch('/api/ads', { cache: 'no-store' })).json()).status);
  if (status !== 'ready') return wait(page, '#emptyState');
  if (view === 'campaigns') {
    await page.locator('button[data-view="campaigns"]').click();
    return wait(page, '#campaignQuadrant .dpp-bubble');
  }
  return wait(page, '#chart .dpp-bar');
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
    return {
      mobile,
      signalsBeforeChart: Boolean(
        signals && chart && signals.getBoundingClientRect().top < chart.getBoundingClientRect().top
      ),
      referenceOpen: Boolean(reference?.hasAttribute('open')),
      primaryVisible: Boolean(primary && primary.getBoundingClientRect().height > 0),
      todayVisible: Boolean(today && today.getBoundingClientRect().height > 0),
    };
  });
  if (
    state.mobile &&
    (!state.signalsBeforeChart || state.referenceOpen || !state.primaryVisible || !state.todayVisible)
  ) {
    throw new Error(`Sales Overview mobile hierarchy mismatch: ${JSON.stringify(state)}`);
  }
  if (!state.mobile && !state.referenceOpen)
    throw new Error('Sales Overview desktop reference context is collapsed');
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
    const hero = document.querySelector('.today-hero');
    const business = document.querySelector('.today-read-panel');
    const queue = document.querySelector('.order-flow-panel');
    const drivers = document.querySelector('.today-drivers-panel');
    const rhythm = document.querySelector('.today-rhythm-panel');
    const evidence = document.getElementById('todayBusinessEvidence');
    const reference = document.getElementById('todayProductsReference');
    const priority = [...document.querySelectorAll('.today-products-priority .today-product')];
    const rhythmKpis = [...document.querySelectorAll('.rhythm-kpi')];
    const tops = rhythmKpis.map(item => Math.round(item.getBoundingClientRect().top));
    return {
      mobile,
      order: [hero, business, queue, drivers, rhythm].map(item =>
        Math.round(item?.getBoundingClientRect().top || 0)
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
    (state.order.some((top, index) => index && top <= state.order[index - 1]) ||
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
    const brief = document.querySelector('.business-brief');
    const attention = document.querySelector('.attention-panel');
    const rhythm = document.querySelector('.rhythm-panel');
    const health = document.querySelector('.business-health');
    const ads = document.getElementById('adsRead');
    const brand = document.querySelector('.topbar a.brand');
    const top = (element) => element?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
    return {
      activeNav: document.querySelector('.nav-primary-set > a.active')?.textContent?.trim(),
      brandPath: brand ? new URL(brand.href).pathname : '',
      singleRead: Boolean(
        brief && !document.querySelector('.page-header') && !document.querySelector('.state-read'),
      ),
      hierarchy: Boolean(
        top(brief) < top(rhythm) && top(rhythm) < top(attention) && top(attention) < top(health),
      ),
      exceptionItems: document.querySelectorAll('.attention-item').length,
      severityBadges: document.querySelectorAll('.attention-item .severity-badge').length,
      clearState: Boolean(document.querySelector('.attention-clear')),
      moreVisible: Boolean(document.querySelector('.attention-more')),
      expectedItems: Math.min(4, exceptions.length),
      expectedMore: exceptions.length > 0 && total > Math.min(4, exceptions.length),
      healthDomains: document.querySelectorAll('.business-health-card').length,
      productDriversRemoved: !document.querySelector('.drivers, #movers, .driver'),
      adsVisible: Boolean(ads && !ads.hidden && getComputedStyle(ads).display !== 'none'),
      adsExpected: Boolean(payload.ads?.through_date),
      adsAfterHealth: !ads || ads.hidden || top(health) < top(ads),
    };
  });
  if (
    state.activeNav !== 'Business' ||
    state.brandPath !== '/today' ||
    !state.singleRead ||
    !state.hierarchy ||
    state.exceptionItems !== state.expectedItems ||
    state.severityBadges !== state.expectedItems ||
    state.clearState !== (state.expectedItems === 0) ||
    state.moreVisible !== state.expectedMore ||
    state.healthDomains !== 3 ||
    !state.productDriversRemoved ||
    state.adsVisible !== state.adsExpected ||
    !state.adsAfterHealth
  ) {
    throw new Error(`Business decision-board contract mismatch: ${JSON.stringify(state)}`);
  }
}
async function verifyDataHealth(page) {
  await wait(page, '.health-summary');
  const mobile = await page.evaluate(() => window.innerWidth <= 640);
  if (mobile) {
    await page.locator('#toggle').click();
    await wait(page, '#jobs .health-job');
  }
  const state = await page.evaluate(async () => {
    const response = await fetch('/api/data-health', { cache: 'no-store' });
    const payload = await response.json();
    const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
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
      attentionVisible: Boolean(attention && !attention.hidden),
      incidents: incidents.length,
      incidentStructure: incidents.every(incident =>
        incident.querySelector('.incident__purpose') &&
        incident.querySelectorAll('.incident__metrics > div').length === 4 &&
        incident.querySelector('.incident__diagnostic')
      ),
      compactCoverage: Boolean(document.querySelector('.domain-summary .domain-chip')),
      warehouseClosed: !document.querySelector('.warehouse-reference')?.hasAttribute('open'),
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
    };
  });
  if (
    !state.apiOk ||
    !state.checkedAt ||
    !state.jobs ||
    !state.contractComplete ||
    !state.compactCoverage ||
    !state.warehouseClosed ||
    !state.genericRingRemoved ||
    !state.mobilePipelineMetrics ||
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
  await wait(page, '.hero-name');
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
  if (!payload.ads?.through_date || !Number(payload.ads?.observed_ads_days || 0)) {
    const adsState = (await page.locator('#adsState').textContent() || '').trim();
    const adsDecision = (await page.locator('#adsDecision').textContent() || '').trim();
    if (adsState !== 'Ads access pending' || adsDecision !== 'Ads integration ready')
      throw new Error(`Product Ads pending language mismatch: ${adsState} / ${adsDecision}`);
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
      decisionsBeforeChart: Boolean(
        decisions && chart && decisions.getBoundingClientRect().top < chart.getBoundingClientRect().top
      ),
      referenceSummaryHeight: summary?.getBoundingClientRect().height || 0,
    };
  });
  if (
    mobileHierarchy.mobile &&
    (mobileHierarchy.referenceOpen ||
      mobileHierarchy.factsVisible ||
      !mobileHierarchy.decisionsBeforeChart ||
      mobileHierarchy.referenceSummaryHeight < 44)
  ) {
    throw new Error(`Product mobile hierarchy mismatch: ${JSON.stringify(mobileHierarchy)}`);
  }
  if (!mobileHierarchy.mobile && !mobileHierarchy.referenceOpen)
    throw new Error('Product desktop secondary context is collapsed');

  await page.locator('#ordersPanel > summary').click();
  await wait(page, '.product-order');
  const orderEvidence = await page.evaluate(() => {
    const orders = [...document.querySelectorAll('.product-order')];
    return {
      count: orders.length,
      structured: orders.every(order =>
        order.querySelector('.product-order__moment') &&
        order.querySelectorAll('.product-order__metric').length === 2 &&
        order.querySelector('.product-order__fulfillment') &&
        order.querySelector('.order-status-pill')
      ),
      statuses: orders.map(order => order.querySelector('.order-status-pill')?.textContent || ''),
    };
  });
  if (!orderEvidence.count || !orderEvidence.structured)
    throw new Error(`Product order evidence structure mismatch: ${JSON.stringify(orderEvidence)}`);
  const leakedOrderPending = orderEvidence.statuses.filter(status =>
    /^pending(?:_availability)?$/i.test(status.trim())
  );
  if (leakedOrderPending.length)
    throw new Error(`Product order evidence leaked raw pending language: ${JSON.stringify(leakedOrderPending)}`);
  if (mobileHierarchy.mobile) await page.locator('#ordersPanel > summary').click();
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
    const chartScroll = document.querySelector('.trajectory-chart-scroll');
    const priority = [...document.querySelectorAll('.structure-priority .structure-card')];
    return {
      mobile,
      emptyPaidVisible: Boolean(paidEmpty && paid && window.getComputedStyle(paid).display !== 'none'),
      guideOpen: Boolean(guide?.hasAttribute('open')),
      referenceOpen: Boolean(reference?.hasAttribute('open')),
      priorityCards: priority.length,
      priorityVisible: priority.filter(card => card.getBoundingClientRect().height > 0).length,
      chartContained: Boolean(chartScroll && chartScroll.scrollWidth > chartScroll.clientWidth),
    };
  });
  if (
    state.mobile &&
    (state.emptyPaidVisible ||
      state.guideOpen ||
      state.referenceOpen ||
      state.priorityCards !== 3 ||
      state.priorityVisible !== 3 ||
      !state.chartContained)
  ) {
    throw new Error(`Trajectory mobile hierarchy mismatch: ${JSON.stringify(state)}`);
  }
  if (!state.mobile && (!state.guideOpen || !state.referenceOpen))
    throw new Error(`Trajectory desktop evidence is collapsed: ${JSON.stringify(state)}`);
}
async function verifyInventory(page) {
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
  // Desktop/tablet expose a table header, while mobile intentionally hides it
  // and presents the data rows as cards. Wait for canonical history data, not
  // the responsive header implementation.
  await wait(page, '#history .history-row:not(.head)');
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
  ['today', '/today', ['mobile', 'desktop'], verifyToday],
  ['today-wall', '/today?wall=1', ['desktop']],
  ['business', '/', ['mobile', 'tablet', 'desktop'], verifyBusiness],
  ['sales-overview', '/sales', ['mobile', 'tablet', 'desktop'], verifySalesOverview],
  ['sales-products', '/sales', ['mobile', 'desktop'], verifySalesProducts],
  ['sales-orders', '/sales', ['mobile', 'desktop'], verifySalesOrders],
  ['catalog', '/catalog', ['mobile', 'tablet', 'desktop'], verifyCatalog],
  ['catalog-design', '/catalog', ['mobile', 'desktop'], p => verifyCatalogMode(p, 'dimension:design')],
  ['catalog-ruling', '/catalog', ['mobile', 'desktop'], p => verifyCatalogMode(p, 'dimension:ruling')],
  ['catalog-combinations', '/catalog', ['mobile', 'desktop'], p => verifyCatalogMode(p, 'pair')],
  ['catalog-sku', '/catalog', ['mobile', 'desktop'], p => verifyCatalogMode(p, 'sku')],
  ['product-pnc-001', '/product?sku=PNC-001', ['mobile', 'desktop'], verifyProductWorkspace],
  ['inventory', '/inventory', ['mobile', 'tablet', 'desktop'], verifyInventory],
  ['ads-overview', '/ads', ['mobile', 'tablet', 'desktop'], p => verifyAds(p)],
  ['ads-campaigns', '/ads', ['mobile', 'desktop'], p => verifyAds(p, 'campaigns')],
  ['finance-overview', '/finance', ['mobile', 'desktop'], verifyFinanceReport],
  ['finance-closed', '/finance', ['mobile', 'tablet', 'desktop'], verifyFinanceClosed],
  ['finance-ledger', '/finance', ['mobile', 'desktop'], verifyFinanceEvidence],
  ['trajectory', '/trajectory', ['mobile', 'desktop'], verifyTrajectory],
  ['data-health', '/data-health', ['mobile', 'desktop'], verifyDataHealth],
].map(([name, url, views, action]) => ({ name, url, views, action }));

await fs.mkdir(outDir, { recursive: true });
for (const entry of await fs.readdir(outDir)) await fs.rm(path.join(outDir, entry), { recursive: true, force: true });
const browser = await chromium.launch({ headless: true });
const results = [];
const safeName = value => value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

for (const scenario of scenarios) for (const viewportName of scenario.views) {
  const viewport = viewports[viewportName];
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, isMobile: viewport.isMobile, hasTouch: viewport.hasTouch, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [], warnings = [], failedResponses = [];
  page.on('pageerror', err => errors.push(`pageerror: ${err.message}`));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(`console: ${msg.text()}`); if (msg.type() === 'warning') warnings.push(`console: ${msg.text()}`); });
  page.on('response', async response => { if (response.status() >= 400 && response.url().startsWith(baseUrl)) failedResponses.push(`${response.status()} ${response.request().method()} ${response.url()}`); });
  const result = { scenario: scenario.name, viewport: viewportName, width: viewport.width, height: viewport.height, url: `${baseUrl}${scenario.url}`, screenshot: null, metrics: null, errors, warnings, failedResponses, ok: false };
  try {
    const response = await page.goto(result.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    if (!response?.ok()) throw new Error(`navigation returned ${response?.status() || 'no response'}`);
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1000);
    if (scenario.action) { await scenario.action(page); await page.waitForTimeout(500); }
    result.metrics = await page.evaluate(({ viewportName }) => {
      const visible = el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || 1) > 0; };
      const minFont = viewportName === 'mobile' ? 11.5 : viewportName === 'tablet' ? 10.5 : 9.5;
      const textEls = [...document.querySelectorAll('body *')].filter(el => visible(el) && !el.children.length && (el.textContent || '').trim());
      const smallText = textEls.filter(el => Number.parseFloat(getComputedStyle(el).fontSize || '0') < minFont).slice(0, 40);
      const clickables = [...document.querySelectorAll('a,button,[role="button"],input,select,textarea')].filter(visible);
      const smallTargets = clickables.filter(el => { const r = el.getBoundingClientRect(); return r.width < 36 || r.height < 36; }).slice(0, 40);
      const doc = document.documentElement, body = document.body, scrollWidth = Math.max(doc.scrollWidth, body.scrollWidth);
      return { title: document.title, bodyTextLength: (body.innerText || '').length, activeTab: document.querySelector('.tabs button.active,.view-tabs button.active,.analysis-modes button.active')?.textContent?.trim() || null, scrollWidth, scrollHeight: Math.max(doc.scrollHeight, body.scrollHeight), horizontalOverflowPx: Math.max(0, scrollWidth - doc.clientWidth), smallTextCount: smallText.length, smallTapTargetCount: smallTargets.length };
    }, { viewportName });
    const fileName = `${safeName(scenario.name)}-${viewportName}.png`;
    await page.screenshot({ path: path.join(outDir, fileName), fullPage: true });
    result.screenshot = fileName;
    result.ok = !errors.length && !failedResponses.length;
  } catch (err) {
    errors.push(`qa: ${err.message}`);
    const fileName = `${safeName(scenario.name)}-${viewportName}-error.png`;
    await page.screenshot({ path: path.join(outDir, fileName), fullPage: true }).catch(() => {});
    result.screenshot = fileName;
  }
  results.push(result);
  await context.close();
}
await browser.close();

const summary = { generatedAt: new Date().toISOString(), baseUrl, captures: results.length, successfulCaptures: results.filter(x => x.ok).length, navigationFailures: results.filter(x => !x.ok).length, consoleErrorCount: results.reduce((n, x) => n + x.errors.length, 0), failedResponseCount: results.reduce((n, x) => n + x.failedResponses.length, 0), horizontalOverflowCaptures: results.filter(x => (x.metrics?.horizontalOverflowPx || 0) > 2).length, smallTextSignals: results.reduce((n, x) => n + (x.metrics?.smallTextCount || 0), 0), smallTapTargetSignals: results.reduce((n, x) => n + (x.metrics?.smallTapTargetCount || 0), 0), results };
await fs.writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
const lines = ['# DPP Visual QA', '', `Generated: ${summary.generatedAt}`, `Base URL: ${baseUrl}`, '', `**${summary.successfulCaptures}/${summary.captures} captures succeeded.**`, '', '| Screen | Viewport | Active tab | Overflow | Small text | Small tap targets | Browser errors |', '|---|---:|---|---:|---:|---:|---:|'];
for (const r of results) lines.push(`| ${r.scenario} | ${r.viewport} ${r.width}×${r.height} | ${r.metrics?.activeTab ?? '—'} | ${r.metrics?.horizontalOverflowPx ?? '—'}px | ${r.metrics?.smallTextCount ?? '—'} | ${r.metrics?.smallTapTargetCount ?? '—'} | ${r.errors.length} |`);
lines.push('', '## Signals', '', `- Horizontal overflow: ${summary.horizontalOverflowCaptures} capture(s)`, `- Small-text signals: ${summary.smallTextSignals}`, `- Small tap-target signals: ${summary.smallTapTargetSignals}`, `- Failed local HTTP responses: ${summary.failedResponseCount}`, `- Browser/page errors: ${summary.consoleErrorCount}`, '', '_Screenshots remain the source of truth for visual judgment._', '');
await fs.writeFile(path.join(outDir, 'report.md'), lines.join('\n'));
console.log(JSON.stringify({ captures: summary.captures, successful: summary.successfulCaptures, navigationFailures: summary.navigationFailures, overflowCaptures: summary.horizontalOverflowCaptures, smallTextSignals: summary.smallTextSignals, smallTapTargetSignals: summary.smallTapTargetSignals, failedResponses: summary.failedResponseCount, browserErrors: summary.consoleErrorCount }, null, 2));
if (summary.navigationFailures || summary.consoleErrorCount || summary.failedResponseCount) process.exitCode = 2;
