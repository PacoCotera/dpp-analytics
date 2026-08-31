import {
  bindRuleDisclosure,
  byId,
  escapeHtml,
  fetchJson,
  formatBusinessClock,
  formatCount,
  formatMetricWindow,
  integer,
  money,
  percent,
  ruleTrigger,
} from './ui-utils.js';

const $ = byId;
const esc = escapeHtml;
const num = integer;
const SELLABLE_ROLES = new Set(['SELLABLE_VARIATION', 'SELLABLE_STANDALONE']);
const FUNNEL_STATES = new Set(['TRAFFIC_NOT_CONVERTING', 'CONVERTS_NEEDS_TRAFFIC']);
const DORMANT_STATES = new Set(['DORMANT', 'WATCH']);
const MOBILE_ROW_LIMIT = 6;
const CATALOG_FILTERS = new Set(['all', 'attention', 'funnel', 'stock', 'dormant', 'inactive']);

const labels = {
  INVENTORY_RISK: 'Inventory risk',
  TRAFFIC_NOT_CONVERTING: 'Traffic not converting',
  CONVERTS_NEEDS_TRAFFIC: 'Converts · needs traffic',
  DECLINING: 'Declining',
  ACCELERATING: 'Accelerating',
  HEALTHY: 'Healthy',
  WATCH: 'Watch',
  DORMANT: 'Dormant',
  LEARNING: 'Learning',
  INACTIVE: 'Inactive',
  CLOSED: 'Closed',
  INCOMPLETE: 'Incomplete',
  NOT_ACTIVE: 'Not active',
  DELETED: 'Deleted',
  STRUCTURAL_PARENT: 'Parent container',
  SKU_ALIAS: 'SKU alias',
};

let DATA = {
  families: [],
  products: [],
  deleted_products: [],
  attention: [],
  summary: {},
  dimensions: {},
  dimension_pairs: [],
};
let filter = 'all';
let mode = 'family';

function availableModes() {
  const modes = new Set(['family', 'sku']);
  Object.keys(DATA.dimensions || {}).forEach((dimension) => modes.add(`dimension:${dimension}`));
  if ((DATA.dimension_pairs || []).length) modes.add('pair');
  if ((DATA.deleted_products || []).length) modes.add('deleted');
  return modes;
}

function readCatalogUrlState() {
  const params = new URLSearchParams(window.location.search);
  const requestedMode = params.get('mode') || 'family';
  mode = availableModes().has(requestedMode) ? requestedMode : 'family';
  const requestedFilter = params.get('filter') || 'all';
  filter = mode === 'family' && CATALOG_FILTERS.has(requestedFilter) ? requestedFilter : 'all';
}

function writeCatalogUrlState({ replace = false } = {}) {
  const url = new URL(window.location.href);
  if (mode === 'family') url.searchParams.delete('mode');
  else url.searchParams.set('mode', mode);
  if (mode === 'family' && filter !== 'all') url.searchParams.set('filter', filter);
  else url.searchParams.delete('filter');
  window.history[replace ? 'replaceState' : 'pushState']({}, '', url);
}

function syncFilterButtons() {
  document.querySelectorAll('.filter').forEach((item) => {
    const selected = item.dataset.filter === filter;
    item.classList.toggle('active', selected);
    item.setAttribute('aria-pressed', String(selected));
  });
}

function restoreCatalogUrlState() {
  readCatalogUrlState();
  syncFilterButtons();
  renderModes();
  renderPortfolio();
}

function pct(value) {
  return percent(value, { sign: false });
}

function ratioPercent(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return percent(100 * Number(value), { sign: false });
}

function decimal(value, digits = 2) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : '—';
}

function familyPaidRead(family) {
  const spend = Number(family.ad_spend_t28 || 0);
  if (!spend) return '';
  const maturity = String(family.ad_attribution_state || 'UNAVAILABLE').toLowerCase();
  return ` · Paid ${money(spend)} · ${ratioPercent(family.ad_tacos_t28)} TACOS · ${decimal(family.ad_roas_t28)}× ROAS · ${maturity}`;
}

function productPaidRead(product) {
  const spend = Number(product.ad_spend_t28 || 0);
  if (!spend) return '';
  const maturity = String(product.ad_attribution_state || 'UNAVAILABLE').toLowerCase();
  return ` · Paid ${money(spend)} · ${ratioPercent(product.ad_tacos_t28)} TACOS · ${decimal(product.ad_roas_t28)}× ROAS · ${maturity}`;
}

function title(value) {
  return String(value || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function stateClass(value) {
  return `state-${value || 'HEALTHY'}`;
}

function members(family) {
  return (family.members || []).filter(
    (item) => item.product_role !== 'STRUCTURAL_PARENT' && item.product_role !== 'SELLER_SKU_ALIAS',
  );
}

function stockTotal(row) {
  return Number(row.available || 0) + Number(row.inbound || 0);
}

function compactFamilyName(family) {
  if (family.name && family.members?.some((item) => item.family_name)) return family.name;
  return (
    family.parent?.product ||
    family.name ||
    members(family)[0]?.product ||
    family.family_asin ||
    'Product family'
  );
}

function dimensionSummary(family) {
  const dimensions = family.variation_dimensions || {};
  const parts = Object.entries(dimensions).map(
    ([key, values]) => `${title(key)}: ${(values || []).join(' / ')}`,
  );
  return parts.length ? ` · ${parts.join(' · ')}` : '';
}

function explanation(family) {
  return family.commercial_explanation || labels[family.primary_state] || 'Portfolio signal';
}

function image(url, className) {
  if (url) return `<img class="${className}" src="${esc(url)}" alt="" loading="lazy">`;
  return `<div class="${className} catalog-image-placeholder" aria-hidden="true"></div>`;
}

function economicsFamily(family) {
  const cogs = Number(family.estimated_cogs_t28 || 0);
  const units = Number(family.units_t28 || 0);
  const knownUnits = Number(family.cogs_known_units || 0);

  if (!cogs && knownUnits === 0)
    return '<strong>—</strong><span data-mobile-label="COGS">cost not set</span>';
  return `<strong>${money(cogs)}</strong><span data-mobile-label="COGS">28D COGS${knownUnits < units ? ' · partial' : ''}</span>`;
}

function economicsChild(product) {
  if (product.unit_cogs === null || product.unit_cogs === undefined) {
    return '<strong>—</strong><span data-mobile-label="COGS">cost not set</span>';
  }

  const detail =
    product.estimated_cogs_t28 !== null && product.estimated_cogs_t28 !== undefined
      ? `${money(product.estimated_cogs_t28)} 28D`
      : 'standard cost';
  return `<strong>${money(product.unit_cogs)}/u</strong><span data-mobile-label="COGS">${detail}</span>`;
}

function familyMatches(family) {
  const query = $('search').value.trim().toLowerCase();
  const familyMembers = members(family);
  const haystack =
    `${compactFamilyName(family)} ${family.family_asin || ''} ${JSON.stringify(family.variation_dimensions || {})} ${familyMembers
      .map(
        (item) =>
          `${item.product || ''} ${item.sku || ''} ${item.asin || ''} ${JSON.stringify(item.variation_attributes || {})}`,
      )
      .join(' ')}`.toLowerCase();

  if (query && !haystack.includes(query)) return false;
  if (filter === 'attention' && !family.needs_attention) return false;
  if (
    filter === 'funnel' &&
    !FUNNEL_STATES.has(family.primary_state) &&
    !familyMembers.some((item) => FUNNEL_STATES.has(item.commercial_state))
  ) {
    return false;
  }
  if (
    filter === 'stock' &&
    family.primary_state !== 'INVENTORY_RISK' &&
    !familyMembers.some((item) => item.commercial_state === 'INVENTORY_RISK')
  ) {
    return false;
  }
  if (
    filter === 'dormant' &&
    !DORMANT_STATES.has(family.primary_state) &&
    !familyMembers.some((item) => DORMANT_STATES.has(item.commercial_state))
  ) {
    return false;
  }
  if (
    filter === 'inactive' &&
    family.primary_state !== 'INACTIVE' &&
    !familyMembers.some((item) => item.commercial_state === 'INACTIVE')
  ) {
    return false;
  }

  return true;
}

function compareRows(sort, a, b, nameA, nameB) {
  if (sort === 'sales') return Number(b.sales_t28 || 0) - Number(a.sales_t28 || 0);
  if (sort === 'traffic') return Number(b.sessions_t28 || 0) - Number(a.sessions_t28 || 0);
  if (sort === 'conversion') return Number(b.conversion_t28_pct || 0) - Number(a.conversion_t28_pct || 0);
  if (sort === 'stock') return stockTotal(a) - stockTotal(b);
  if (sort === 'name') return String(nameA || '').localeCompare(String(nameB || ''));
  return 0;
}

function familySorted() {
  const sort = $('sort').value;
  return DATA.families.filter(familyMatches).sort((a, b) => {
    if (sort === 'attention') {
      return (
        Number(b.needs_attention) - Number(a.needs_attention) ||
        Number(b.sales_t28 || 0) - Number(a.sales_t28 || 0)
      );
    }
    return compareRows(sort, a, b, compactFamilyName(a), compactFamilyName(b));
  });
}

function childRow(product) {
  const cover = product.days_cover_with_inbound ?? product.days_cover_on_hand;
  const stock = stockTotal(product);
  const delta = product.sales_delta28_pct;
  const attributes = Object.entries(product.variation_attributes || {})
    .map(([key, value]) => `${title(key)}: ${value}`)
    .join(' · ');
  const sourceStatus = String(product.status || '').trim();
  const listingLabel = sourceStatus.toLowerCase() === 'active' ? 'sellable' : sourceStatus.toLowerCase();

  const productName = product.product || product.sku || product.asin;

  return `<div class="child">
    <a class="child-identity" href="/product?sku=${encodeURIComponent(product.sku || '')}">
      ${image(product.image_url, 'child-img')}
      <div>
        <div class="child-name">${esc(productName)}</div>
        <div class="child-meta">${esc(product.sku || '')} · ${esc(product.asin || '')}${attributes ? ` · ${esc(attributes)}` : ''} · ${esc(listingLabel || 'status unavailable')}${esc(productPaidRead(product))}</div>
      </div>
    </a>
    <div class="signal ${stateClass(product.commercial_state)}">
      <strong>${esc(labels[product.commercial_state] || product.commercial_state || 'Product')}</strong>${ruleTrigger(product.commercial_evaluation, DATA.interpretation_rules)}
      <span>${esc(product.commercial_explanation || '')}</span>
    </div>
    <div class="cell metric-sales" data-mobile-title="28D sales"><strong>${money(product.sales_t28)}</strong><span data-mobile-label="28D">${formatCount(product.units_t28, 'unit')}${delta === null || delta === undefined ? '' : ` · ${Number(delta) >= 0 ? '+' : ''}${Number(delta).toFixed(0)}%`}</span></div>
    <div class="cell metric-funnel" data-mobile-title="Conversion"><strong>${num(product.sessions_t28)} sessions</strong><span data-mobile-label="Funnel"><b>${pct(product.conversion_t28_pct)}</b> CVR${product.sessions_delta28_pct === null || product.sessions_delta28_pct === undefined ? '' : ` · traffic ${Number(product.sessions_delta28_pct) >= 0 ? '+' : ''}${Number(product.sessions_delta28_pct).toFixed(0)}%`}</span></div>
    <div class="cell metric-stock" data-mobile-title="Available"><strong>${formatCount(product.units_t28, 'unit')}</strong><span data-mobile-label="Stock"><b>${num(stock)}</b> stock${cover === null || cover === undefined ? '' : ` · ${Number(cover).toFixed(0)}d cover`}</span></div>
    <div class="cell economics">${economicsChild(product)}</div>
  </div>`;
}

function familyRow(family) {
  const familyMembers = members(family);
  const name = compactFamilyName(family);
  const cover =
    family.days_cover_with_inbound === null || family.days_cover_with_inbound === undefined
      ? null
      : Number(family.days_cover_with_inbound);
  const stock = stockTotal(family);
  const state = family.primary_state || 'HEALTHY';
  const children = familyMembers.map(childRow).join('');
  const familyRule = ruleTrigger(family.commercial_evaluation, DATA.interpretation_rules);
  const aliases = (family.aliases || []).length;
  const exceptions = Number(family.child_exception_count || 0);
  const lifecycle =
    family.catalog_lifecycle === 'CURRENT_FAMILY'
      ? ' · current catalog'
      : family.catalog_lifecycle
        ? ' · catalog cleanup required'
        : '';

  return `<details class="family" data-family="${esc(family.family_asin || '')}">
    <summary>
      <div class="identity">
        ${image(family.image_url, 'family-img')}
        <div>
          <div class="family-name">${esc(name)}</div>
          <div class="family-meta">${familyMembers.length} sellable ${familyMembers.length === 1 ? 'offer' : 'variations'} · ${family.active_sellable_count || 0} active${lifecycle}${family.parent ? ' · variation family' : ''}${exceptions ? ` · ${exceptions} child exception${exceptions === 1 ? '' : 's'}` : ''}${esc(dimensionSummary(family))}${esc(familyPaidRead(family))}</div>
        </div>
      </div>
      <div class="signal ${stateClass(state)}"><strong>${esc(labels[state] || state)}</strong><span>${esc(explanation(family))}</span></div>
      <div class="cell metric-sales" data-mobile-title="28D sales"><strong>${money(family.sales_t28)}</strong><span data-mobile-label="28D">${formatCount(family.units_t28, 'unit')}</span></div>
      <div class="cell metric-funnel" data-mobile-title="Conversion"><strong>${num(family.sessions_t28)} sessions</strong><span data-mobile-label="Funnel"><b>${pct(family.conversion_t28_pct)}</b> CVR</span></div>
      <div class="cell metric-stock" data-mobile-title="Available"><strong>${formatCount(family.units_t28, 'unit')}</strong><span data-mobile-label="Stock"><b>${num(stock)}</b> stock${cover === null ? ' · no velocity' : ` · ${cover.toFixed(0)}d pooled cover`}</span></div>
      <div class="cell economics">${economicsFamily(family)}</div>
      <span class="chev">›</span>
    </summary>
    ${familyRule ? `<div class="family-rule-row"><span>Commercial interpretation</span>${familyRule}</div>` : ''}
    <div class="children">
      <div class="child-head"><span>Variation</span><span>Commercial read</span><span>28D shopper spend incl. IVA</span><span>Traffic → CVR</span><span>Units → stock</span><span class="economics">Economics</span></div>
      ${children || '<div class="empty">No sellable child offers in this family.</div>'}
      ${aliases ? `<div class="alias-note">${aliases} operational seller-SKU ${aliases === 1 ? 'alias is' : 'aliases are'} hidden from demand totals to avoid double counting.</div>` : ''}
    </div>
  </details>`;
}

function comparativeRead(row) {
  const total = Number(DATA.summary?.sales_t28 || 0);
  const share = total > 0 ? (100 * Number(row.sales_t28 || 0)) / total : 0;
  const evaluation = row.conversion_evaluation || {};

  return [
    evaluation.label || 'Portfolio comparison',
    `${share.toFixed(0)}% of 28D sales · ${row.family_count || 0} ${Number(row.family_count || 0) === 1 ? 'family' : 'families'}`,
  ];
}

function dimensionRow(row, kind) {
  const stock = stockTotal(row);
  const read = comparativeRead(row);
  const name = kind === 'pair' ? row.label : row.value;
  const scope = kind === 'pair' ? (row.dimensions || []).map(title).join(' × ') : title(row.dimension);

  return `<div class="analysis-row" role="row">
    <div class="analysis-identity" role="rowheader"><strong><span class="analysis-mark"></span>${esc(name)}</strong><span>${esc(scope)} · ${row.sku_count || 0} SKUs · ${row.active_sku_count || 0} active</span></div>
    <div class="signal" role="cell"><strong>${esc(read[0])}</strong>${ruleTrigger(row.conversion_evaluation, DATA.interpretation_rules)}<span>${esc(read[1])}</span></div>
    <div class="cell metric-sales" role="cell" data-mobile-title="28D sales"><strong>${money(row.sales_t28)}</strong><span data-mobile-label="28D">${formatCount(row.units_t28, 'unit')}</span></div>
    <div class="cell metric-funnel" role="cell" data-mobile-title="Conversion"><strong>${num(row.sessions_t28)} sessions</strong><span data-mobile-label="Funnel"><b>${pct(row.conversion_t28_pct)}</b> CVR</span></div>
    <div class="cell metric-stock" role="cell" data-mobile-title="Available"><strong>${formatCount(row.units_t28, 'unit')}</strong><span data-mobile-label="Stock"><b>${num(stock)}</b> stock</span></div>
    <div class="cell economics" role="cell"><strong>${row.estimated_cogs_t28 === null || row.estimated_cogs_t28 === undefined ? '—' : money(row.estimated_cogs_t28)}</strong><span data-mobile-label="COGS">28D COGS</span></div>
    <span class="analysis-open-cell" role="cell"><span class="analysis-open" aria-hidden="true">·</span></span>
  </div>`;
}

function skuRows() {
  const query = $('search').value.trim().toLowerCase();
  const sort = $('sort').value;
  const rows = (DATA.products || [])
    .filter((product) => SELLABLE_ROLES.has(product.product_role))
    .filter(
      (product) =>
        !query ||
        `${product.product || ''} ${product.sku || ''} ${product.asin || ''} ${JSON.stringify(product.variation_attributes || {})}`
          .toLowerCase()
          .includes(query),
    );

  rows.sort((a, b) =>
    compareRows(sort === 'attention' ? 'sales' : sort, a, b, a.product || a.sku, b.product || b.sku),
  );
  return rows;
}

function skuAnalysisRow(product) {
  const stock = stockTotal(product);
  const attributes = Object.entries(product.variation_attributes || {})
    .map(([key, value]) => `${title(key)}: ${value}`)
    .join(' · ');

  const productName = product.product || product.sku || product.asin;

  return `<div class="analysis-row" role="row">
    <div class="analysis-identity" role="rowheader"><a class="analysis-link" href="/product?sku=${encodeURIComponent(product.sku || '')}"><strong>${esc(productName)}</strong><span>${esc(product.sku || '')} · ${esc(attributes || 'standalone')}${esc(productPaidRead(product))}</span></a></div>
    <div class="signal ${stateClass(product.commercial_state)}" role="cell"><strong>${esc(labels[product.commercial_state] || product.commercial_state || 'Product')}</strong>${ruleTrigger(product.commercial_evaluation, DATA.interpretation_rules)}<span>${esc(product.commercial_explanation || '')}</span></div>
    <div class="cell metric-sales" role="cell" data-mobile-title="28D sales"><strong>${money(product.sales_t28)}</strong><span data-mobile-label="28D">${formatCount(product.units_t28, 'unit')}</span></div>
    <div class="cell metric-funnel" role="cell" data-mobile-title="Conversion"><strong>${num(product.sessions_t28)} sessions</strong><span data-mobile-label="Funnel"><b>${pct(product.conversion_t28_pct)}</b> CVR</span></div>
    <div class="cell metric-stock" role="cell" data-mobile-title="Available"><strong>${formatCount(product.units_t28, 'unit')}</strong><span data-mobile-label="Stock"><b>${num(stock)}</b> stock</span></div>
    <div class="cell economics" role="cell">${economicsChild(product)}</div>
    <span class="analysis-open-cell" role="cell"><a class="analysis-open" href="/product?sku=${encodeURIComponent(product.sku || '')}" aria-label="Open ${esc(productName)} product workspace">›</a></span>
  </div>`;
}

function deletedAnalysisRow(product) {
  const parent = product.historical_parent_asin ? ` · former parent ${product.historical_parent_asin}` : '';
  const lastSeen = String(product.last_seen_at || '').slice(0, 10) || 'date unavailable';
  const sourceStatus = product.source_listing_status || 'unknown';

  const name = product.product || product.sku || product.asin;
  return `<div class="analysis-row" role="row">
    <div class="analysis-identity" role="rowheader"><a class="analysis-link" href="/product?sku=${encodeURIComponent(product.sku || '')}"><strong>${esc(name)}</strong><span>${esc(product.sku || '')} · ${esc(product.asin || '')}${esc(parent)}</span></a></div>
    <div class="signal state-DELETED" role="cell"><strong>Deleted</strong><span>Absent from the latest Amazon seller-catalog snapshot</span></div>
    <div class="cell metric-sales" role="cell" data-mobile-title="Catalog state"><strong>Historical</strong><span data-mobile-label="Scope">not a current offer</span></div>
    <div class="cell metric-funnel" role="cell" data-mobile-title="Last Amazon state"><strong>${esc(sourceStatus)}</strong><span data-mobile-label="Last state">last reported status</span></div>
    <div class="cell metric-stock" role="cell" data-mobile-title="Last seen"><strong>${esc(lastSeen)}</strong><span data-mobile-label="Last seen">seller snapshot</span></div>
    <div class="cell economics" role="cell"><strong>Preserved</strong><span data-mobile-label="History">transaction history</span></div>
    <span class="analysis-open-cell" role="cell"><a class="analysis-open" href="/product?sku=${encodeURIComponent(product.sku || '')}" aria-label="Open ${esc(name)} historical product workspace">›</a></span>
  </div>`;
}

function renderModes() {
  const dimensions = Object.keys(DATA.dimensions || {});
  const buttons = [
    ['family', 'Family'],
    ...dimensions.map((dimension) => [`dimension:${dimension}`, title(dimension)]),
  ];

  if ((DATA.dimension_pairs || []).length) {
    const pairDimensions = [...new Set(DATA.dimension_pairs.flatMap((item) => item.dimensions || []))];
    buttons.push([
      'pair',
      pairDimensions.length === 2 ? pairDimensions.map(title).join(' × ') : 'Combinations',
    ]);
  }
  buttons.push(['sku', 'SKU']);
  if ((DATA.deleted_products || []).length) buttons.push(['deleted', 'Deleted']);

  $('analysisModes').innerHTML = buttons
    .map(
      ([key, label]) =>
        `<button class="mode choice-control ${key === mode ? 'active' : ''}" type="button" data-mode="${esc(key)}" aria-pressed="${key === mode}">${esc(label)}</button>`,
    )
    .join('');

  $('analysisModes')
    .querySelectorAll('.mode')
    .forEach((button) => {
      button.addEventListener('click', () => {
        if (button.dataset.mode === mode && filter === 'all') return;
        mode = button.dataset.mode;
        filter = 'all';
        syncFilterButtons();
        writeCatalogUrlState();
        renderModes();
        renderPortfolio();
      });
    });
}

function setHead(first = 'Family / product') {
  $('portfolioHead').innerHTML =
    `<span role="columnheader">${esc(first)}</span><span role="columnheader">Commercial read</span><span role="columnheader">28D shopper spend incl. IVA</span><span role="columnheader">Traffic → CVR</span><span role="columnheader">Units → stock</span><span role="columnheader">Economics</span><span role="columnheader">Open</span>`;
}

function sortAnalysisRows(rows) {
  const sort = $('sort').value;
  return [...rows].sort((a, b) =>
    compareRows(sort === 'attention' ? 'sales' : sort, a, b, a.label || a.value, b.label || b.value),
  );
}

function analysisRows(rows, renderRow, label) {
  const query = $('search').value.trim();
  if (query || rows.length <= MOBILE_ROW_LIMIT) return rows.map(renderRow).join('');

  const primary = rows.slice(0, MOBILE_ROW_LIMIT);
  const additional = rows.slice(MOBILE_ROW_LIMIT);
  const open = window.matchMedia('(max-width: 720px)').matches ? '' : ' open';
  const noun = additional.length === 1 ? label : `${label}s`;

  return `${primary.map(renderRow).join('')}
    <details class="catalog-reference-disclosure" data-catalog-overflow-count="${additional.length}"${open}>
      <summary>
        <span><span class="catalog-reference-show">Show</span><span class="catalog-reference-hide">Hide</span> ${additional.length} additional ${esc(noun)}</span>
        <strong>Reference</strong>
      </summary>
      <div class="catalog-reference-rows">${additional.map(renderRow).join('')}</div>
    </details>`;
}

function renderPortfolio() {
  const query = $('search').value.trim().toLowerCase();
  const familyMode = mode === 'family';
  const evidence = document.querySelector('.catalog-evidence');
  if (familyMode) evidence.removeAttribute('role');
  else evidence.setAttribute('role', 'table');
  $('filters').classList.toggle('hidden', !familyMode);
  $('filters').closest('.catalog-filter-field').hidden = !familyMode;

  if (familyMode) {
    setHead();
    $('modeSource').textContent = 'Family = child roll-up';
    $('portfolioFootMain').textContent = 'Roll-up of sellable child products.';
    const rows = familySorted();
    $('portfolio').innerHTML = rows.length
      ? rows.map(familyRow).join('')
      : '<div class="empty">No commercial families match this view.</div>';
    return;
  }

  if (mode === 'sku') {
    setHead('Sellable SKU');
    $('modeSource').textContent = 'SKU = purchasable combination';
    $('portfolioFootMain').textContent = 'Purchasable child and standalone offers.';
    const rows = skuRows();
    $('portfolio').innerHTML = rows.length
      ? analysisRows(rows, skuAnalysisRow, 'SKU')
      : '<div class="empty">No sellable SKUs match this view.</div>';
    return;
  }

  if (mode === 'deleted') {
    setHead('Deleted SKU');
    $('modeSource').textContent = 'Deleted = absent from latest Amazon snapshot';
    $('portfolioFootMain').textContent = 'Historical only; excluded from the current portfolio.';
    let rows = DATA.deleted_products || [];
    if (query) rows = rows.filter((row) => JSON.stringify(row).toLowerCase().includes(query));
    $('portfolio').innerHTML = rows.length
      ? analysisRows(rows, deletedAnalysisRow, 'deleted SKU')
      : '<div class="empty">No deleted SKU records match this view.</div>';
    return;
  }

  let rows = [];
  let label = 'Variation';

  if (mode === 'pair') {
    rows = DATA.dimension_pairs || [];
    label = 'Variation combination';
    $('modeSource').textContent = 'Combination = cross-dimensional roll-up';
  } else {
    const dimension = mode.split(':')[1];
    rows = (DATA.dimensions || {})[dimension] || [];
    label = title(dimension);
    $('modeSource').textContent = `${title(dimension)} = cross-family roll-up`;
  }

  if (query) rows = rows.filter((row) => JSON.stringify(row).toLowerCase().includes(query));
  rows = sortAnalysisRows(rows);

  setHead(label);
  $('portfolioFootMain').textContent = 'Conversion = total units ÷ total sessions.';
  $('portfolio').innerHTML = rows.length
    ? analysisRows(
        rows,
        (row) => dimensionRow(row, mode === 'pair' ? 'pair' : 'dimension'),
        mode === 'pair' ? 'combination' : `${label.toLowerCase()} entry`,
      )
    : '<div class="empty">No variation data is available for this analysis.</div>';
}

function render(data) {
  DATA = data;
  readCatalogUrlState();
  bindRuleDisclosure(data.interpretation_rules);
  const summary = data.summary || {};
  const familyAttention = (data.families || []).filter((family) => family.needs_attention).length;

  $('clock').textContent = formatBusinessClock(data.local_time);
  $('familyCount').textContent = num(summary.families);
  $('activeCount').textContent = num(summary.active_sellable);
  $('sellingCount').textContent = num(summary.selling_now);
  $('attentionCount').textContent = num(familyAttention);
  $('portfolioRead').textContent =
    `${money(summary.sales_t28)} from ${formatCount(summary.units_t28, 'unit')} on ${formatCount(summary.sessions_t28, 'session')} · ${pct(summary.conversion_t28_pct)} conversion`;
  $('portfolioBasis').textContent =
    `28D through ${summary.traffic_through_date || 'latest completed day'} · ${summary.sellable_offers || 0} current Amazon offers across ${summary.families || 0} families · ${summary.amazon_dimension_coverage || 0} offers with Amazon variation metadata${Number(summary.ad_spend_t28 || 0) > 0 ? ` · Paid support ${money(summary.ad_spend_t28)} · ${ratioPercent(summary.ad_tacos_t28)} TACOS · ${decimal(summary.ad_roas_t28)}× attributed ROAS` : ' · Paid support awaiting Amazon Ads data'}`;
  $('catalogDemandWindow').textContent = formatMetricWindow(data.metric_windows?.RECONCILED_PRODUCT_T28);
  $('asof').textContent = `Demand through ${summary.traffic_through_date || '—'}`;
  $('freshness').textContent =
    `Data Kiosk through ${summary.traffic_through_date || '—'} · listings ${String(summary.listings_fetched_at || '').slice(0, 10) || '—'} · FBA current${Number(summary.ad_spend_t28 || 0) > 0 ? ` · Ads through ${summary.ads_through_date || 'latest available day'}` : ''}`;

  syncFilterButtons();
  renderModes();
  renderPortfolio();
  writeCatalogUrlState({ replace: true });
}

async function load() {
  try {
    render(await fetchJson('/api/catalog'));
  } catch (error) {
    $('portfolio').innerHTML = `<div class="empty">Catalog unavailable · ${esc(error.message)}</div>`;
    $('asof').textContent = 'Feed unavailable';
  }
}

function bindInteractions() {
  $('search').addEventListener('input', renderPortfolio);
  $('sort').addEventListener('change', renderPortfolio);
  document.querySelectorAll('.filter').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.dataset.filter === filter) return;
      document.querySelectorAll('.filter').forEach((item) => {
        item.classList.remove('active');
        item.setAttribute('aria-pressed', 'false');
      });
      button.classList.add('active');
      button.setAttribute('aria-pressed', 'true');
      filter = button.dataset.filter;
      writeCatalogUrlState();
      renderPortfolio();
    });
  });
}

bindInteractions();
window.addEventListener('popstate', restoreCatalogUrlState);
load();
