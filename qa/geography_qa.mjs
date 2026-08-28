import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const baseUrl = (process.argv[2] || 'http://127.0.0.1:8088').replace(/\/$/, '');
const outDir = process.argv[3] || '/out';
await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
let geographyRequests = 0;
let stateGeometryRequests = 0;
const externalGeometryRequests = [];
page.on('pageerror', err => errors.push(`pageerror: ${err.message}`));
page.on('console', msg => { if (msg.type() === 'error') errors.push(`console: ${msg.text()}`); });
page.on('request', request => {
  const url = new URL(request.url());
  if (url.pathname === '/api/sales/geography') geographyRequests += 1;
  if (url.pathname === '/assets/mexico-states-90a1d52.geojson') stateGeometryRequests += 1;
  if (['raw.githubusercontent.com', 'github.com'].includes(url.hostname) && /geojson|geograph|states/i.test(url.pathname)) {
    externalGeometryRequests.push(request.url());
  }
});

const isOrdered = (values, direction) => values.every((value, index) => {
  if (!index) return true;
  return direction === 'desc' ? values[index - 1] >= value : values[index - 1] <= value;
});

try {
  const response = await page.goto(`${baseUrl}/sales`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  if (!response?.ok()) throw new Error(`Sales navigation returned ${response?.status() || 'no response'}`);
  if (geographyRequests !== 0) throw new Error(`Sales initial load eagerly requested geography ${geographyRequests} time(s)`);

  const coreApi = await page.evaluate(async () => {
    const r = await fetch('/api/sales', { cache: 'no-store' });
    const body = await r.json();
    return {
      status: r.status,
      body,
      cacheStatus: r.headers.get('X-DPP-Cache'),
      payloadBytes: new TextEncoder().encode(JSON.stringify(body)).length,
    };
  });
  if (coreApi.status !== 200) throw new Error(`Sales API ${coreApi.status}`);
  if ('geography' in coreApi.body) throw new Error('Default Sales payload still contains geography');
  if (!coreApi.cacheStatus) throw new Error('Default Sales payload did not expose cache status');

  const geoApi = await page.evaluate(async () => {
    const r = await fetch('/api/sales/geography', { cache: 'no-store' });
    const body = await r.json();
    return {
      status: r.status,
      body,
      cacheStatus: r.headers.get('X-DPP-Cache'),
      payloadBytes: new TextEncoder().encode(JSON.stringify(body)).length,
    };
  });
  if (geoApi.status !== 200) throw new Error(`Sales geography API ${geoApi.status}`);
  if (!geoApi.cacheStatus) throw new Error('Sales geography payload did not expose cache status');
  const catalogApi = await page.evaluate(async () => {
    const r = await fetch('/api/catalog', { cache: 'no-store' });
    return { status: r.status, body: await r.json() };
  });
  if (catalogApi.status !== 200) throw new Error(`Catalog API ${catalogApi.status}`);
  const geo = geoApi.body?.geography || {};
  const coverage = geo.coverage || {};
  if (!Array.isArray(geo.daily) || !geo.daily.length) throw new Error('Postal geography daily fact is empty');
  if (!Array.isArray(geo.sku_daily) || !geo.sku_daily.length) throw new Error('Postal SKU geography fact is empty');
  if (Number(coverage.orders_with_postal || 0) <= 0) throw new Error('No orders have postal geography');
  if (Number(coverage.postal_codes || 0) <= 0) throw new Error('No postal codes reported');
  if (Number(coverage.coverage_pct || 0) <= 0) throw new Error('Postal coverage is zero');
  if (Number(coverage.canonical_states || 0) <= 0 || Number(coverage.canonical_states || 0) > 32) {
    throw new Error(`Canonical state count is invalid: ${JSON.stringify(coverage)}`);
  }
  if (Number(coverage.unmapped_orders || 0) !== Number(coverage.orders_total || 0) - Number(coverage.resolved_state_orders || 0)) {
    throw new Error(`Unmapped order count does not reconcile: ${JSON.stringify(coverage)}`);
  }
  if (Number(coverage.alias_resolution_pct || 0) <= 0) throw new Error('State alias resolution coverage is zero');
  const canonicalGeographyDates = (geo.daily || []).map(row => String(row.business_date || '').slice(0, 10)).filter(Boolean).sort();
  if (String(coverage.geography_last_date || '').slice(0, 10) !== canonicalGeographyDates.at(-1)) {
    throw new Error(`Geography cutoff does not match resolved postal evidence: ${JSON.stringify(coverage)}`);
  }
  const nonCanonicalRows = [...(geo.daily || []), ...(geo.sku_daily || [])].filter(row =>
    !/^\d{2}$/.test(String(row.state_code || '')) || !String(row.state_name || '').trim()
  );
  if (nonCanonicalRows.length) throw new Error(`Geography payload contains noncanonical state rows: ${nonCanonicalRows.length}`);

  const sellableRoles = new Set(['SELLABLE_VARIATION', 'SELLABLE_STANDALONE']);
  const catalogCurrentOffers = (catalogApi.body?.products || []).filter(row =>
    row.is_offer_owner && sellableRoles.has(row.product_role) && row.catalog_membership === 'CURRENT_OFFER'
  );
  const geographyCurrentOffers = (geo.products || []).filter(row => row.is_current_offer);
  const catalogCurrentSkus = catalogCurrentOffers.map(row => String(row.sku || '')).filter(Boolean).sort();
  const geographyCurrentSkus = geographyCurrentOffers.map(row => String(row.analysis_sku || row.sku || '')).filter(Boolean).sort();
  if (JSON.stringify(catalogCurrentSkus) !== JSON.stringify(geographyCurrentSkus)) {
    throw new Error(`Geography current products differ from canonical Catalog offers: ${JSON.stringify({ catalogCurrentSkus, geographyCurrentSkus })}`);
  }
  if (new Set(geographyCurrentSkus).size !== geographyCurrentSkus.length) {
    throw new Error(`Geography current product identities are duplicated: ${geographyCurrentSkus.join(', ')}`);
  }
  if (Number(geo.product_analysis?.current_offers || 0) !== catalogCurrentOffers.length) {
    throw new Error(`Geography product contract count differs from Catalog: ${JSON.stringify(geo.product_analysis)}`);
  }
  if ((geo.product_analysis?.ambiguous_current_asins || []).length) {
    throw new Error(`Geography cannot safely collapse aliases for ambiguous current ASINs: ${JSON.stringify(geo.product_analysis.ambiguous_current_asins)}`);
  }
  const pncAliasRows = (geo.sku_daily || []).filter(row => String(row.source_sku || '') === 'PNC-001-FBM');
  if (pncAliasRows.some(row => row.analysis_sku !== 'PNC-001' || !row.is_alias)) {
    throw new Error(`Historical PNC-001-FBM evidence did not collapse into PNC-001: ${JSON.stringify(pncAliasRows.slice(0, 3))}`);
  }
  const canonicalPnc = (geo.products || []).find(row => String(row.sku || '') === 'PNC-001');
  if (!canonicalPnc?.source_skus?.includes('PNC-001-FBM') || Number(geo.product_analysis?.collapsed_alias_source_skus || 0) < 1) {
    throw new Error(`Geography product contract did not preserve PNC-001-FBM as canonical PNC-001 source evidence: ${JSON.stringify({ canonicalPnc, productAnalysis: geo.product_analysis })}`);
  }
  if ((geo.products || []).some(row => String(row.sku || '') === 'PNC-001-FBM')) {
    throw new Error('Historical PNC-001-FBM alias remains a Geography product option');
  }

  const references = Array.isArray(geo.postal_reference) ? geo.postal_reference : [];
  if (!references.length) throw new Error('SEPOMEX postal reference dictionary is empty');
  const namedReferences = references.filter(ref =>
    String(ref?.municipality_name || ref?.city_name || '').trim() ||
    (Array.isArray(ref?.settlements) && ref.settlements.some(value => String(value || '').trim()))
  );
  if (!namedReferences.length) throw new Error('Postal reference dictionary has no human-readable place names');

  const forbidden = ['recipient', 'buyername', 'buyer_name', 'addressline', 'address_line', 'phone', 'deliveryinstruction'];
  const keys = [];
  const walk = value => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      keys.push(String(key).toLowerCase());
      walk(child);
    }
  };
  walk(geo);
  const leaked = forbidden.filter(word => keys.some(key => key.includes(word)));
  if (leaked.length) throw new Error(`Geography payload exposes forbidden PII-shaped keys: ${leaked.join(', ')}`);

  const requestsBeforeOpen = geographyRequests;
  await page.locator('button[data-view="geography"]').click();
  await page.locator('#geography.view.active').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('#geoRankedRows tr').first().waitFor({ state: 'visible', timeout: 8000 });
  await page.locator('#geoMap path.state-shape').first().waitFor({ state: 'visible', timeout: 15000 });
  if (geographyRequests <= requestsBeforeOpen) throw new Error('Opening Geography did not request its lazy payload');
  if (stateGeometryRequests !== 1) throw new Error(`Expected one bundled state geometry request, got ${stateGeometryRequests}`);
  if (externalGeometryRequests.length) {
    throw new Error(`Geography requested third-party geometry at runtime: ${externalGeometryRequests.join(', ')}`);
  }

  const maxProductDate = new Date(`${String(coverage.geography_last_date || '').slice(0, 10)}T12:00:00Z`);
  const productStart90 = new Date(maxProductDate);
  productStart90.setUTCDate(productStart90.getUTCDate() - 89);
  const productEvidence90 = new Set((geo.sku_daily || []).filter(row => {
    const date = new Date(`${String(row.business_date || '').slice(0, 10)}T12:00:00Z`);
    return date >= productStart90 && date <= maxProductDate;
  }).map(row => String(row.analysis_sku || '')).filter(Boolean));
  const expectedPrimary90 = geographyCurrentOffers
    .filter(row => row.is_active_offer && productEvidence90.has(String(row.analysis_sku || row.sku || '')))
    .map(row => String(row.analysis_sku || row.sku || ''))
    .sort();
  const defaultProductControl = await page.evaluate(() => ({
    values: [...document.querySelectorAll('#geoProduct option')].map(option => option.value),
    groups: [...document.querySelectorAll('#geoProduct optgroup')].map(group => group.label),
    scope: document.getElementById('geoProductScope')?.textContent?.trim() || '',
    secondaryLabel: document.getElementById('geoSecondaryProducts')?.textContent?.trim() || '',
    secondaryExpanded: document.getElementById('geoSecondaryProducts')?.getAttribute('aria-expanded'),
  }));
  const defaultProductValues = defaultProductControl.values.filter(value => value !== 'all').sort();
  if (JSON.stringify(defaultProductValues) !== JSON.stringify(expectedPrimary90)) {
    throw new Error(`Default 90D products do not equal current offers with evidence: ${JSON.stringify({ expectedPrimary90, defaultProductControl })}`);
  }
  if (defaultProductControl.groups.length !== 1 || !defaultProductControl.groups[0].includes('Current offers with Last 90 days evidence')) {
    throw new Error(`Default product grouping is not explicit: ${JSON.stringify(defaultProductControl)}`);
  }
  if (!defaultProductControl.scope.includes(`${expectedPrimary90.length} current products with Last 90 days evidence`) || defaultProductControl.secondaryExpanded !== 'false') {
    throw new Error(`Default product scope disclosure is incomplete: ${JSON.stringify(defaultProductControl)}`);
  }

  await page.locator('#geoSecondaryProducts').click();
  const expandedProductControl = await page.evaluate(() => ({
    values: [...document.querySelectorAll('#geoProduct option')].map(option => option.value),
    groups: [...document.querySelectorAll('#geoProduct optgroup')].map(group => group.label),
    labels: [...document.querySelectorAll('#geoProduct option')].map(option => option.textContent?.trim() || ''),
    scope: document.getElementById('geoProductScope')?.textContent?.trim() || '',
    expanded: document.getElementById('geoSecondaryProducts')?.getAttribute('aria-expanded'),
  }));
  const expectedAllAnalysisSkus = (geo.products || []).map(row => String(row.analysis_sku || row.sku || '')).filter(Boolean).sort();
  const expandedAnalysisSkus = expandedProductControl.values.filter(value => value !== 'all').sort();
  if (JSON.stringify(expandedAnalysisSkus) !== JSON.stringify(expectedAllAnalysisSkus)) {
    throw new Error(`Secondary product choice is incomplete: ${JSON.stringify({ expectedAllAnalysisSkus, expandedProductControl })}`);
  }
  if (expandedProductControl.groups.length !== 2 || expandedProductControl.expanded !== 'true' || !expandedProductControl.scope.endsWith('shown')) {
    throw new Error(`Secondary product disclosure is incomplete: ${JSON.stringify(expandedProductControl)}`);
  }
  if (expandedProductControl.values.includes('PNC-001-FBM') || !expandedProductControl.labels.some(label => label.includes('Historical transactions'))) {
    throw new Error(`Secondary products revive an alias or omit historical labels: ${JSON.stringify(expandedProductControl)}`);
  }
  await page.locator('#geoSecondaryProducts').click();

  await page.locator('[data-geo-range="30d"]').click();
  const productStart30 = new Date(maxProductDate);
  productStart30.setUTCDate(productStart30.getUTCDate() - 29);
  const productEvidence30 = new Set((geo.sku_daily || []).filter(row => {
    const date = new Date(`${String(row.business_date || '').slice(0, 10)}T12:00:00Z`);
    return date >= productStart30 && date <= maxProductDate;
  }).map(row => String(row.analysis_sku || '')).filter(Boolean));
  const expectedPrimary30 = geographyCurrentOffers
    .filter(row => row.is_active_offer && productEvidence30.has(String(row.analysis_sku || row.sku || '')))
    .map(row => String(row.analysis_sku || row.sku || ''))
    .sort();
  const productValues30 = (await page.locator('#geoProduct option').evaluateAll(options => options.map(option => option.value)))
    .filter(value => value !== 'all')
    .sort();
  if (JSON.stringify(productValues30) !== JSON.stringify(expectedPrimary30)) {
    throw new Error(`30D product scope did not rebuild from the global Geography cutoff: ${JSON.stringify({ expectedPrimary30, productValues30 })}`);
  }
  await page.locator('[data-geo-range="90d"]').click();

  const national = await page.evaluate(() => {
    const scroll = document.querySelector('.geo-ranked-panel .data-table-scroll');
    const table = document.querySelector('.geo-table');
    const firstRow = document.querySelector('#geoRankedRows tr');
    const widths = firstRow ? [...firstRow.children].map(cell => cell.getBoundingClientRect().width) : [];
    const tableWidth = table?.getBoundingClientRect().width || 0;
    return {
      coverage: document.getElementById('geoCoverage')?.textContent?.trim() || '',
      rankedRows: document.querySelectorAll('#geoRankedRows tr').length,
      stateShapes: document.querySelectorAll('#geoMap path.state-shape').length,
      kpis: [...document.querySelectorAll('#geoKpis .geo-kpi strong')].map(x => x.textContent?.trim() || ''),
      headerColumns: document.querySelectorAll('.geo-table thead th').length,
      sortableColumns: document.querySelectorAll('.geo-table thead th[data-geo-sort] button').length,
      rowDisclosure: document.getElementById('geoSortStatus')?.textContent?.trim() || '',
      showAllLabel: document.getElementById('geoShowAll')?.textContent?.trim() || '',
      showAllHidden: document.getElementById('geoShowAll')?.hidden,
      widths,
      tableWidth,
      tableOverflow: scroll ? scroll.scrollWidth - scroll.clientWidth : 999,
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  if (!national.coverage.includes('canonical states') || !national.coverage.includes('unmapped orders') || !national.coverage.includes('alias resolution')) {
    throw new Error(`Canonical coverage copy not rendered: ${national.coverage}`);
  }
  if (national.rankedRows <= 0 || national.stateShapes < 30) throw new Error(`Geography rendering incomplete: ${JSON.stringify(national)}`);
  const nationalCountMatch = national.rowDisclosure.match(/Showing (\d+) of (\d+) states/);
  if (!nationalCountMatch || Number(nationalCountMatch[1]) !== national.rankedRows || !national.rowDisclosure.includes('sorted by Spend ↓')) {
    throw new Error(`National row count or sort disclosure is incomplete: ${JSON.stringify(national)}`);
  }
  const nationalTotalRows = Number(nationalCountMatch[2]);
  if (nationalTotalRows > 20 && (national.showAllHidden || national.showAllLabel !== `Show all ${nationalTotalRows}`)) {
    throw new Error(`National Show all control is incomplete: ${JSON.stringify(national)}`);
  }
  if (national.kpis.length !== 4) throw new Error(`Expected four geography KPIs, got ${national.kpis.length}`);
  if (national.headerColumns !== 5 || national.sortableColumns !== 5) throw new Error(`Expected five sortable geography columns: ${JSON.stringify(national)}`);
  if (national.widths.length !== 5 || national.tableWidth <= 0) throw new Error(`Geography column sizing unavailable: ${JSON.stringify(national)}`);
  const ratios = national.widths.map(width => width / national.tableWidth);
  if (!(ratios[0] > .42 && ratios[0] < .50 && ratios[1] > .15 && ratios[1] < .21 && ratios[2] > .10 && ratios[2] < .16 && ratios[3] > .08 && ratios[3] < .14 && ratios[4] > .09 && ratios[4] < .16)) {
    throw new Error(`Geography columns do not use the assigned space: ${JSON.stringify(ratios)}`);
  }
  if (national.tableOverflow > 1) throw new Error(`Geography ranked table horizontally overflows by ${national.tableOverflow}px`);
  if (national.pageOverflow > 1) throw new Error(`Geography page horizontally overflows by ${national.pageOverflow}px`);

  const defaultSales = await page.locator('#geoRankedRows tr td:nth-child(2)').evaluateAll(cells => cells.map(cell => Number(cell.dataset.value || 0)));
  if (!isOrdered(defaultSales, 'desc')) throw new Error(`Default Spend sort is not descending: ${defaultSales.join(',')}`);

  await page.locator('th[data-geo-sort="orders"] button').click();
  const orderSort = await page.evaluate(() => ({
    aria: document.querySelector('th[data-geo-sort="orders"]')?.getAttribute('aria-sort'),
    values: [...document.querySelectorAll('#geoRankedRows tr td:nth-child(3)')].map(cell => Number(cell.dataset.value || 0)),
    status: document.getElementById('geoSortStatus')?.textContent?.trim() || '',
  }));
  if (orderSort.aria !== 'descending' || !isOrdered(orderSort.values, 'desc')) throw new Error(`Orders descending sort failed: ${JSON.stringify(orderSort)}`);

  await page.locator('th[data-geo-sort="orders"] button').click();
  const orderSortAsc = await page.evaluate(() => ({
    aria: document.querySelector('th[data-geo-sort="orders"]')?.getAttribute('aria-sort'),
    values: [...document.querySelectorAll('#geoRankedRows tr td:nth-child(3)')].map(cell => Number(cell.dataset.value || 0)),
  }));
  if (orderSortAsc.aria !== 'ascending' || !isOrdered(orderSortAsc.values, 'asc')) throw new Error(`Orders ascending sort failed: ${JSON.stringify(orderSortAsc)}`);

  await page.locator('th[data-geo-sort="sales"] button').click();
  await page.screenshot({ path: path.join(outDir, 'sales-geography-desktop.png'), fullPage: true });

  const geographyDates = (geo.daily || []).map(row => String(row.business_date || '').slice(0, 10)).filter(Boolean).sort();
  const maxGeographyDate = geographyDates.at(-1);
  const geographyStart = new Date(`${maxGeographyDate}T12:00:00Z`);
  geographyStart.setUTCDate(geographyStart.getUTCDate() - 89);
  const shortStatePostals = new Map();
  for (const row of geo.daily || []) {
    const date = new Date(`${String(row.business_date || '').slice(0, 10)}T12:00:00Z`);
    if (date < geographyStart || date > new Date(`${maxGeographyDate}T12:00:00Z`)) continue;
    const code = String(row.state_code || '');
    if (!shortStatePostals.has(code)) shortStatePostals.set(code, new Set());
    shortStatePostals.get(code).add(String(row.postal_code || '').padStart(5, '0'));
  }
  const shortState = [...shortStatePostals.entries()].find(([, codes]) => codes.size > 0 && codes.size <= 20);
  if (!shortState) throw new Error('No short postal drill-down is available to verify the complete-list edge case');
  await page.locator('#geoStateSelect').selectOption(shortState[0]);
  const shortPostalTable = await page.evaluate(() => ({
    visibleRows: document.querySelectorAll('#geoRankedRows tr').length,
    status: document.getElementById('geoSortStatus')?.textContent?.trim() || '',
    showAllHidden: document.getElementById('geoShowAll')?.hidden,
  }));
  if (shortPostalTable.visibleRows !== shortState[1].size || !shortPostalTable.status.includes(`Showing all ${shortState[1].size} postal codes`) || !shortPostalTable.showAllHidden) {
    throw new Error(`Short postal list should render completely without an expansion control: ${JSON.stringify({ shortState: shortState[0], expected: shortState[1].size, shortPostalTable })}`);
  }
  await page.locator('#geoStateSelect').selectOption('all');

  const postalResponsePromise = page.waitForResponse(
    r => {
      const url = new URL(r.url());
      return url.pathname === '/api/geography/postal-geometry' && url.searchParams.get('state') === '15' && r.request().method() === 'GET';
    },
    { timeout: 60000 },
  );
  await page.locator('#geoStateSelect').selectOption('15');
  const postalResponse = await postalResponsePromise;
  if (!postalResponse.ok()) throw new Error(`Postal geometry endpoint returned ${postalResponse.status()}`);
  const postalPayload = await postalResponse.json();
  if (!String(postalPayload.geometry_contract || '').includes('D3 clockwise exterior rings')) {
    throw new Error(`Postal geometry contract is missing D3 winding normalization: ${JSON.stringify(postalPayload.geometry_contract)}`);
  }
  if (!String(postalPayload.source || '').includes('ff9a744d')) {
    throw new Error(`Postal geometry does not disclose the pinned image source: ${JSON.stringify(postalPayload.source)}`);
  }
  if (!Array.isArray(postalPayload.features) || !postalPayload.features.length) throw new Error('Estado de México postal geometry is empty');

  const windingAudit = await page.evaluate(payload => {
    const area = ring => {
      let total = 0;
      for (let i = 0; i < ring.length - 1; i += 1) total += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
      return total / 2;
    };
    const polygons = [];
    for (const feature of payload.features || []) {
      const geometry = feature?.geometry || {};
      if (geometry.type === 'Polygon') polygons.push(geometry.coordinates);
      else if (geometry.type === 'MultiPolygon') polygons.push(...(geometry.coordinates || []));
    }
    const outerAreas = polygons.map(polygon => area(polygon[0] || []));
    const holeAreas = polygons.flatMap(polygon => (polygon || []).slice(1).map(area));
    const positions = [];
    const collect = value => {
      if (!Array.isArray(value)) return;
      if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
        positions.push([Number(value[0]), Number(value[1])]);
        return;
      }
      value.forEach(collect);
    };
    (payload.features || []).forEach(feature => collect(feature?.geometry?.coordinates));
    return {
      polygonCount: polygons.length,
      badOuter: outerAreas.filter(value => !(value < 0)).length,
      badHoles: holeAreas.filter(value => !(value > 0)).length,
      badPositions: positions.filter(([lon, lat]) => lon < -120 || lon > -85 || lat < 10 || lat > 35).length,
    };
  }, postalPayload);
  if (windingAudit.polygonCount <= 0 || windingAudit.badOuter || windingAudit.badHoles || windingAudit.badPositions) {
    throw new Error(`Postal geometry winding/coordinate audit failed: ${JSON.stringify(windingAudit)}`);
  }

  await page.locator('#geoMap path.postal-shape').first().waitFor({ state: 'visible', timeout: 60000 });
  await page.waitForFunction(() => /active postal polygons mapped/.test(document.getElementById('geoMapStatus')?.textContent || ''), null, { timeout: 60000 });
  await page.locator('#geoRankedRows .geo-area-cell small').first().waitFor({ state: 'visible', timeout: 8000 });

  const postalTableBeforeExpansion = await page.evaluate(() => ({
    visibleRows: document.querySelectorAll('#geoRankedRows tr').length,
    status: document.getElementById('geoSortStatus')?.textContent?.trim() || '',
    showAllHidden: document.getElementById('geoShowAll')?.hidden,
    showAllLabel: document.getElementById('geoShowAll')?.textContent?.trim() || '',
    expanded: document.getElementById('geoShowAll')?.getAttribute('aria-expanded'),
  }));
  const expectedPostalRows = Number(postalPayload.requested_codes || 0);
  const expectedLimitedRows = Math.min(20, expectedPostalRows);
  if (postalTableBeforeExpansion.visibleRows !== expectedLimitedRows) {
    throw new Error(`Postal table limit is not explicit and deterministic: ${JSON.stringify({ expectedPostalRows, postalTableBeforeExpansion })}`);
  }
  const expectedCountCopy = expectedPostalRows > 20
    ? `Showing 20 of ${expectedPostalRows} postal codes`
    : `Showing all ${expectedPostalRows} postal codes`;
  if (!postalTableBeforeExpansion.status.includes(expectedCountCopy) || !postalTableBeforeExpansion.status.includes('sorted by Spend ↓')) {
    throw new Error(`Postal row count or sort disclosure is incomplete: ${JSON.stringify(postalTableBeforeExpansion)}`);
  }
  if (expectedPostalRows > 20) {
    if (postalTableBeforeExpansion.showAllHidden || postalTableBeforeExpansion.showAllLabel !== `Show all ${expectedPostalRows}` || postalTableBeforeExpansion.expanded !== 'false') {
      throw new Error(`Postal Show all control is incomplete: ${JSON.stringify(postalTableBeforeExpansion)}`);
    }
    await page.locator('#geoShowAll').click();
    const expandedPostalTable = await page.evaluate(() => ({
      visibleRows: document.querySelectorAll('#geoRankedRows tr').length,
      status: document.getElementById('geoSortStatus')?.textContent?.trim() || '',
      button: document.getElementById('geoShowAll')?.textContent?.trim() || '',
      expanded: document.getElementById('geoShowAll')?.getAttribute('aria-expanded'),
    }));
    if (expandedPostalTable.visibleRows !== expectedPostalRows || !expandedPostalTable.status.includes(`Showing all ${expectedPostalRows} postal codes`) || expandedPostalTable.button !== 'Show top 20' || expandedPostalTable.expanded !== 'true') {
      throw new Error(`Postal Show all did not expose the complete set: ${JSON.stringify(expandedPostalTable)}`);
    }
    await page.locator('#geoShowAll').click();
    if (await page.locator('#geoRankedRows tr').count() !== 20) throw new Error('Postal Show top 20 did not restore the limited view');
  } else if (!postalTableBeforeExpansion.showAllHidden) {
    throw new Error(`Postal Show all should be hidden for a complete short list: ${JSON.stringify(postalTableBeforeExpansion)}`);
  }

  const postal = await page.evaluate(() => {
    const scroll = document.querySelector('.geo-ranked-panel .data-table-scroll');
    const svg = document.getElementById('geoMap');
    const vb = svg?.viewBox?.baseVal;
    const paths = [...document.querySelectorAll('#geoMap path.postal-shape')];
    const boxes = paths.map(path => {
      const box = path.getBBox();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    });
    const label = document.querySelector('#geoRankedRows .geo-area-cell small')?.textContent?.trim() || '';
    const status = document.getElementById('geoMapStatus')?.textContent?.trim() || '';
    const match = status.match(/(\d+)\/(\d+) active postal polygons mapped/);
    const invalidBoxes = vb ? boxes.filter(box =>
      ![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
      box.x < -vb.width * .1 || box.y < -vb.height * .1 ||
      box.x + box.width > vb.width * 1.1 || box.y + box.height > vb.height * 1.1 ||
      box.width > vb.width * .9 || box.height > vb.height * .9
    ) : boxes;
    return {
      status,
      matched: match ? Number(match[1]) : 0,
      requested: match ? Number(match[2]) : 0,
      postalShapes: paths.length,
      contextShapes: document.querySelectorAll('#geoMap path.geo-state-context').length,
      placeLabel: label,
      visibleRows: document.querySelectorAll('#geoRankedRows tr').length,
      rowDisclosure: document.getElementById('geoSortStatus')?.textContent?.trim() || '',
      invalidBoxes: invalidBoxes.length,
      svgOverflow: svg ? getComputedStyle(svg).overflow : '',
      tableOverflow: scroll ? scroll.scrollWidth - scroll.clientWidth : 999,
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  if (postal.matched <= 0 || postal.postalShapes <= 0) throw new Error(`Postal polygons did not map: ${JSON.stringify(postal)}`);
  if (postal.invalidBoxes) throw new Error(`Postal polygons escape or dominate the state viewport: ${JSON.stringify(postal)}`);
  if (postal.svgOverflow !== 'hidden') throw new Error(`Postal SVG overflow is not contained: ${postal.svgOverflow}`);
  if (!postal.placeLabel || /^CP\s*\d+$/i.test(postal.placeLabel)) throw new Error(`Postal place dictionary did not render a useful label: ${JSON.stringify(postal.placeLabel)}`);
  if (postal.tableOverflow > 1) throw new Error(`Postal ranked table horizontally overflows by ${postal.tableOverflow}px`);
  if (postal.pageOverflow > 1) throw new Error(`Postal drill-down page horizontally overflows by ${postal.pageOverflow}px`);

  const fallbackPage = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await fallbackPage.route(url => url.pathname === '/assets/mexico-states-90a1d52.geojson', route =>
    route.fulfill({ status: 503, contentType: 'application/geo+json', body: '{"error":"test"}' }),
  );
  await fallbackPage.goto(`${baseUrl}/sales?geometry-fallback=1`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await fallbackPage.locator('button[data-view="geography"]').click();
  await fallbackPage.waitForFunction(
    () => document.getElementById('geoMapStatus')?.textContent?.includes('Map geometry unavailable'),
    null,
    { timeout: 15000 },
  );
  const fallback = await fallbackPage.evaluate(() => ({
    status: document.getElementById('geoMapStatus')?.textContent?.trim() || '',
    mapText: document.querySelector('#geoMap .geo-map-fallback')?.textContent?.trim() || '',
    rankedRows: document.querySelectorAll('#geoRankedRows tr').length,
  }));
  await fallbackPage.close();
  if (fallback.mapText !== 'Map geometry unavailable' || fallback.rankedRows <= 0) {
    throw new Error(`Geometry failure did not retain the ranked table fallback: ${JSON.stringify(fallback)}`);
  }
  if (errors.length) throw new Error(errors.join('; '));

  await page.screenshot({ path: path.join(outDir, 'sales-geography-postal-desktop.png'), fullPage: true });
  await fs.writeFile(path.join(outDir, 'geography-summary.json'), JSON.stringify({
    ok: true,
    lazyContract: {
      geographyRequestsBeforeOpen: requestsBeforeOpen,
      geographyRequestsAfterOpen: geographyRequests,
      corePayloadBytes: coreApi.payloadBytes,
      geographyPayloadBytes: geoApi.payloadBytes,
      coreCacheStatus: coreApi.cacheStatus,
      geographyCacheStatus: geoApi.cacheStatus,
    },
    coverage,
    referenceCount: references.length,
    geometryRuntime: {
      stateAssetRequests: stateGeometryRequests,
      externalRequests: externalGeometryRequests,
      fallback,
    },
    national,
    orderSort,
    orderSortAsc,
    postalGeometry: {
      requested: postalPayload.requested_codes,
      matched: postalPayload.matched_codes,
      missing: postalPayload.missing_codes,
      invalid: postalPayload.invalid_codes,
      rewoundRingCount: postalPayload.rewound_ring_count,
      windingAudit,
    },
    postal,
  }, null, 2));
  console.log(JSON.stringify({
    ok: true,
    lazyContract: {
      geographyRequestsBeforeOpen: requestsBeforeOpen,
      geographyRequestsAfterOpen: geographyRequests,
      corePayloadBytes: coreApi.payloadBytes,
      geographyPayloadBytes: geoApi.payloadBytes,
      coreCacheStatus: coreApi.cacheStatus,
      geographyCacheStatus: geoApi.cacheStatus,
    },
    coverage,
    referenceCount: references.length,
    geometryRuntime: {
      stateAssetRequests: stateGeometryRequests,
      externalRequests: externalGeometryRequests,
      fallback,
    },
    national,
    windingAudit,
    postal,
  }));
} catch (err) {
  await page.screenshot({ path: path.join(outDir, 'sales-geography-error.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(outDir, 'geography-summary.json'), JSON.stringify({ ok: false, error: err.message, errors }, null, 2));
  console.error(err);
  await browser.close();
  process.exit(1);
}

await browser.close();
