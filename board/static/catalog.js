import { byId, escapeHtml, integer, money } from './ui-utils.js';

const $ = byId;
const esc = escapeHtml;
const num = integer;
const SELLABLE_ROLES = new Set(['SELLABLE_VARIATION', 'SELLABLE_STANDALONE']);
const BAD_STATES = new Set(['INVENTORY_RISK', 'TRAFFIC_NOT_CONVERTING', 'DECLINING']);
const FUNNEL_STATES = new Set(['TRAFFIC_NOT_CONVERTING', 'CONVERTS_NEEDS_TRAFFIC']);
const DORMANT_STATES = new Set(['DORMANT', 'WATCH']);

const labels = {
  INVENTORY_RISK: 'Inventory risk',
  TRAFFIC_NOT_CONVERTING: 'Traffic not converting',
  CONVERTS_NEEDS_TRAFFIC: 'Converts · needs traffic',
  DECLINING: 'Declining',
  ACCELERATING: 'Accelerating',
  HEALTHY: 'Healthy',
  WATCH: 'Watch',
  DORMANT: 'Dormant',
  INACTIVE: 'Inactive',
  STRUCTURAL_PARENT: 'Parent container',
  SKU_ALIAS: 'SKU alias',
};

let DATA = {
  families: [],
  products: [],
  attention: [],
  summary: {},
  dimensions: {},
  dimension_pairs: [],
};
let filter = 'all';
let mode = 'family';

function pct(value) {
  return value === null || value === undefined ? '—' : `${Number(value).toFixed(1)}%`;
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

function minCover(family) {
  const values = members(family)
    .map((item) => Number(item.days_cover_with_inbound ?? item.days_cover_on_hand))
    .filter(Number.isFinite);
  return values.length ? Math.min(...values) : null;
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
  const inactive = String(product.status || '').toLowerCase() === 'inactive';

  return `<a class="child" href="/product?sku=${encodeURIComponent(product.sku || '')}">
    <div class="child-identity">
      ${image(product.image_url, 'child-img')}
      <div>
        <div class="child-name">${esc(product.product || product.sku || product.asin)}</div>
        <div class="child-meta">${esc(product.sku || '')} · ${esc(product.asin || '')}${attributes ? ` · ${esc(attributes)}` : ''} · ${inactive ? 'inactive' : 'sellable'}</div>
      </div>
    </div>
    <div class="signal ${stateClass(product.commercial_state)}">
      <strong>${esc(labels[product.commercial_state] || product.commercial_state || 'Product')}</strong>
      <span>${esc(product.commercial_explanation || '')}</span>
    </div>
    <div class="cell"><strong>${money(product.sales_t28)}</strong><span data-mobile-label="28D">${num(product.units_t28)} units${delta === null || delta === undefined ? '' : ` · ${Number(delta) >= 0 ? '+' : ''}${Number(delta).toFixed(0)}%`}</span></div>
    <div class="cell"><strong>${num(product.sessions_t28)} sessions</strong><span data-mobile-label="Funnel"><b>${pct(product.conversion_t28_pct)}</b> CVR${product.sessions_delta28_pct === null || product.sessions_delta28_pct === undefined ? '' : ` · traffic ${Number(product.sessions_delta28_pct) >= 0 ? '+' : ''}${Number(product.sessions_delta28_pct).toFixed(0)}%`}</span></div>
    <div class="cell"><strong>${num(product.units_t28)} units</strong><span data-mobile-label="Stock"><b>${num(stock)}</b> stock${cover === null || cover === undefined ? '' : ` · ${Number(cover).toFixed(0)}d cover`}</span></div>
    <div class="cell economics">${economicsChild(product)}</div>
  </a>`;
}

function familyRow(family) {
  const familyMembers = members(family);
  const name = compactFamilyName(family);
  const cover = minCover(family);
  const stock = stockTotal(family);
  const state = family.primary_state || 'HEALTHY';
  const children = familyMembers.map(childRow).join('');
  const aliases = (family.aliases || []).length;
  const exceptions = Number(family.child_exception_count || 0);

  return `<details class="family" data-family="${esc(family.family_asin || '')}">
    <summary>
      <div class="identity">
        ${image(family.image_url, 'family-img')}
        <div>
          <div class="family-name">${esc(name)}</div>
          <div class="family-meta">${familyMembers.length} sellable ${familyMembers.length === 1 ? 'offer' : 'variations'} · ${family.active_sellable_count || 0} active${family.parent ? ' · variation family' : ''}${exceptions ? ` · ${exceptions} child exception${exceptions === 1 ? '' : 's'}` : ''}${esc(dimensionSummary(family))}</div>
        </div>
      </div>
      <div class="signal ${stateClass(state)}"><strong>${esc(labels[state] || state)}</strong><span>${esc(explanation(family))}</span></div>
      <div class="cell"><strong>${money(family.sales_t28)}</strong><span data-mobile-label="28D">${num(family.units_t28)} units</span></div>
      <div class="cell"><strong>${num(family.sessions_t28)} sessions</strong><span data-mobile-label="Funnel"><b>${pct(family.conversion_t28_pct)}</b> CVR</span></div>
      <div class="cell"><strong>${num(family.units_t28)} units</strong><span data-mobile-label="Stock"><b>${num(stock)}</b> stock${cover === null ? '' : ` · ${cover.toFixed(0)}d cover`}</span></div>
      <div class="cell economics">${economicsFamily(family)}</div>
      <span class="chev">›</span>
    </summary>
    <div class="children">
      <div class="child-head"><span>Variation</span><span>Commercial read</span><span>28D</span><span>Traffic → CVR</span><span>Units → stock</span><span class="economics">Economics</span></div>
      ${children || '<div class="empty">No sellable child offers in this family.</div>'}
      ${aliases ? `<div class="alias-note">${aliases} operational seller-SKU ${aliases === 1 ? 'alias is' : 'aliases are'} hidden from demand totals to avoid double counting.</div>` : ''}
    </div>
  </details>`;
}

function comparativeRead(row) {
  const total = Number(DATA.summary?.sales_t28 || 0);
  const overall = Number(DATA.summary?.conversion_t28_pct || 0);
  const share = total > 0 ? (100 * Number(row.sales_t28 || 0)) / total : 0;
  const conversion =
    row.conversion_t28_pct === null || row.conversion_t28_pct === undefined
      ? null
      : Number(row.conversion_t28_pct);
  let headline = 'Portfolio comparison';

  if (conversion !== null && overall > 0 && conversion >= overall * 1.2)
    headline = 'Converts above portfolio';
  else if (conversion !== null && overall > 0 && conversion <= overall * 0.8)
    headline = 'Converts below portfolio';
  else if (conversion !== null) headline = 'Near portfolio conversion';

  return [
    headline,
    `${share.toFixed(0)}% of 28D sales · ${row.family_count || 0} ${Number(row.family_count || 0) === 1 ? 'family' : 'families'}`,
  ];
}

function dimensionRow(row, kind) {
  const stock = stockTotal(row);
  const read = comparativeRead(row);
  const name = kind === 'pair' ? row.label : row.value;
  const scope = kind === 'pair' ? (row.dimensions || []).map(title).join(' × ') : title(row.dimension);

  return `<div class="analysis-row">
    <div class="analysis-identity"><strong><span class="analysis-mark"></span>${esc(name)}</strong><span>${esc(scope)} · ${row.sku_count || 0} SKUs · ${row.active_sku_count || 0} active</span></div>
    <div class="signal"><strong>${esc(read[0])}</strong><span>${esc(read[1])}</span></div>
    <div class="cell"><strong>${money(row.sales_t28)}</strong><span data-mobile-label="28D">${num(row.units_t28)} units</span></div>
    <div class="cell"><strong>${num(row.sessions_t28)} sessions</strong><span data-mobile-label="Funnel"><b>${pct(row.conversion_t28_pct)}</b> CVR</span></div>
    <div class="cell"><strong>${num(row.units_t28)} units</strong><span data-mobile-label="Stock"><b>${num(stock)}</b> stock</span></div>
    <div class="cell economics"><strong>${row.estimated_cogs_t28 === null || row.estimated_cogs_t28 === undefined ? '—' : money(row.estimated_cogs_t28)}</strong><span data-mobile-label="COGS">28D COGS</span></div>
    <span class="analysis-open">·</span>
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

  return `<a class="analysis-row analysis-link" href="/product?sku=${encodeURIComponent(product.sku || '')}">
    <div class="analysis-identity"><strong>${esc(product.product || product.sku || product.asin)}</strong><span>${esc(product.sku || '')} · ${esc(attributes || 'standalone')}</span></div>
    <div class="signal ${stateClass(product.commercial_state)}"><strong>${esc(labels[product.commercial_state] || product.commercial_state || 'Product')}</strong><span>${esc(product.commercial_explanation || '')}</span></div>
    <div class="cell"><strong>${money(product.sales_t28)}</strong><span data-mobile-label="28D">${num(product.units_t28)} units</span></div>
    <div class="cell"><strong>${num(product.sessions_t28)} sessions</strong><span data-mobile-label="Funnel"><b>${pct(product.conversion_t28_pct)}</b> CVR</span></div>
    <div class="cell"><strong>${num(product.units_t28)} units</strong><span data-mobile-label="Stock"><b>${num(stock)}</b> stock</span></div>
    <div class="cell economics">${economicsChild(product)}</div>
    <span class="analysis-open">›</span>
  </a>`;
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

  $('analysisModes').innerHTML = buttons
    .map(
      ([key, label]) =>
        `<button class="mode ${key === mode ? 'active' : ''}" data-mode="${esc(key)}">${esc(label)}</button>`,
    )
    .join('');

  $('analysisModes')
    .querySelectorAll('.mode')
    .forEach((button) => {
      button.addEventListener('click', () => {
        mode = button.dataset.mode;
        filter = 'all';
        document
          .querySelectorAll('.filter')
          .forEach((item) => item.classList.toggle('active', item.dataset.filter === 'all'));
        renderModes();
        renderPortfolio();
      });
    });
}

function setHead(first = 'Family / product') {
  $('portfolioHead').innerHTML =
    `<span>${esc(first)}</span><span>Commercial read</span><span>28D</span><span>Traffic → CVR</span><span>Units → stock</span><span>Economics</span><span></span>`;
}

function sortAnalysisRows(rows) {
  const sort = $('sort').value;
  return [...rows].sort((a, b) =>
    compareRows(sort === 'attention' ? 'sales' : sort, a, b, a.label || a.value, b.label || b.value),
  );
}

function renderPortfolio() {
  const query = $('search').value.trim().toLowerCase();
  $('filters').classList.toggle('hidden', mode !== 'family');

  if (mode === 'family') {
    setHead();
    $('modeSource').textContent = 'Family = child roll-up';
    $('portfolioFootMain').innerHTML =
      '<b>Family metrics</b> roll up sellable children. Structural parents are containers, never selling/converting offers.';
    const rows = familySorted();
    $('portfolio').innerHTML = rows.length
      ? rows.map(familyRow).join('')
      : '<div class="empty">No commercial families match this view.</div>';
    return;
  }

  if (mode === 'sku') {
    setHead('Sellable SKU');
    $('modeSource').textContent = 'SKU = purchasable combination';
    $('portfolioFootMain').innerHTML =
      '<b>SKU metrics</b> are child/standalone offer facts. Parent containers and operational aliases are excluded.';
    const rows = skuRows();
    $('portfolio').innerHTML = rows.length
      ? rows.map(skuAnalysisRow).join('')
      : '<div class="empty">No sellable SKUs match this view.</div>';
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
  $('portfolioFootMain').innerHTML =
    '<b>Dimensional metrics</b> recompute conversion from total units ÷ total sessions. Differences are descriptive signals, not proof that the variation attribute caused performance.';
  $('portfolio').innerHTML = rows.length
    ? rows.map((row) => dimensionRow(row, mode === 'pair' ? 'pair' : 'dimension')).join('')
    : '<div class="empty">No variation data is available for this analysis.</div>';
}

function renderAttention() {
  const attention = (DATA.families || []).filter((family) => family.needs_attention).slice(0, 3);
  $('attentionList').innerHTML = attention.length
    ? attention
        .map((family) => {
          const state = family.primary_state || 'WATCH';
          const exceptions = Number(family.child_exception_count || 0);
          return `<div class="attention-item ${BAD_STATES.has(state) ? 'bad' : 'warn'}">
            <strong>${esc(compactFamilyName(family))}</strong>
            <span>${esc(labels[state] || state)} · ${esc(explanation(family))}${exceptions ? ` · ${exceptions} child exception${exceptions === 1 ? '' : 's'}` : ''}</span>
          </div>`;
        })
        .join('')
    : '<div class="attention-empty">Nothing in the portfolio currently needs exceptional attention.</div>';
}

function render(data) {
  DATA = data;
  const summary = data.summary || {};
  const familyAttention = (data.families || []).filter((family) => family.needs_attention).length;

  $('clock').textContent = data.local_time || '--:--';
  $('familyCount').textContent = num(summary.families);
  $('activeCount').textContent = num(summary.active_sellable);
  $('sellingCount').textContent = num(summary.selling_now);
  $('attentionCount').textContent = num(familyAttention);
  $('portfolioRead').textContent =
    `${money(summary.sales_t28)} from ${num(summary.units_t28)} units on ${num(summary.sessions_t28)} sessions · ${pct(summary.conversion_t28_pct)} conversion`;
  $('portfolioBasis').textContent =
    `28D through ${summary.traffic_through_date || 'latest completed day'} · ${summary.sellable_offers || 0} sellable offers across ${summary.families || 0} families · ${summary.amazon_dimension_coverage || 0} offers with Amazon variation metadata`;
  $('asof').textContent = `Demand through ${summary.traffic_through_date || '—'}`;
  $('freshness').textContent =
    `Data Kiosk through ${summary.traffic_through_date || '—'} · listings ${String(summary.listings_fetched_at || '').slice(0, 10) || '—'} · FBA current`;

  renderAttention();
  renderModes();
  renderPortfolio();
}

async function load() {
  try {
    const response = await fetch('/api/catalog', { cache: 'no-store' });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${response.status}`);
    }
    render(await response.json());
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
      document.querySelectorAll('.filter').forEach((item) => item.classList.remove('active'));
      button.classList.add('active');
      filter = button.dataset.filter;
      renderPortfolio();
    });
  });
}

bindInteractions();
load();
