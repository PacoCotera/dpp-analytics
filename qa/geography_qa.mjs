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
page.on('pageerror', err => errors.push(`pageerror: ${err.message}`));
page.on('console', msg => { if (msg.type() === 'error') errors.push(`console: ${msg.text()}`); });
page.on('request', request => {
  if (new URL(request.url()).pathname === '/api/sales/geography') geographyRequests += 1;
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
  const nonCanonicalRows = [...(geo.daily || []), ...(geo.sku_daily || [])].filter(row =>
    !/^\d{2}$/.test(String(row.state_code || '')) || !String(row.state_name || '').trim()
  );
  if (nonCanonicalRows.length) throw new Error(`Geography payload contains noncanonical state rows: ${nonCanonicalRows.length}`);

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
