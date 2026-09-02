import {
  byId,
  escapeHtml,
  fetchJson,
  formatBusinessClock,
  formatMetricWindow,
  integer,
  revealActiveChoice,
  setText,
} from './ui-utils.js';

const ATTENTION_ACTIONS = new Set(['STOCKOUT', 'PRODUCE', 'PLAN']);
const URGENT_ACTIONS = new Set(['STOCKOUT', 'PRODUCE']);
const KNOWN_ACTIONS = new Set(['STOCKOUT', 'PRODUCE', 'PLAN', 'OK', 'HOLD']);
const INVENTORY_SCOPES = new Set([
  'current',
  'attention',
  'ok',
  'no_velocity',
  'alias',
  'retired',
  'archived',
  'all',
]);
const MAX_SEARCH_LENGTH = 120;

const state = {
  rows: [],
  filter: 'current',
  search: '',
};

const LIFECYCLE_LABELS = {
  CURRENT_OFFER: 'Current offer',
  ALIAS: 'Alias',
  RETIRED: 'Retired',
  ARCHIVED: 'Archived',
};

function normalizeSearch(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .slice(0, MAX_SEARCH_LENGTH)
    .trim();
}

function readInventoryUrlState() {
  const params = new URLSearchParams(window.location.search);
  const requestedScope = params.get('scope') || 'current';
  state.filter = INVENTORY_SCOPES.has(requestedScope) ? requestedScope : 'current';
  state.search = normalizeSearch(params.get('q'));
}

function writeInventoryUrlState(method = 'pushState') {
  const url = new URL(window.location.href);
  if (state.filter === 'current') url.searchParams.delete('scope');
  else url.searchParams.set('scope', state.filter);
  const query = normalizeSearch(state.search);
  if (query) url.searchParams.set('q', query);
  else url.searchParams.delete('q');
  window.history[method]({}, '', url);
}

function syncInventoryControls() {
  byId('search').value = state.search;
  const filterGroup = document.querySelector('.inventory-filter-field .filters');
  document.querySelectorAll('.filter').forEach((button) => {
    const selected = button.dataset.filter === state.filter;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  revealActiveChoice(filterGroup);
}

function restoreInventoryUrlState({ normalize = false } = {}) {
  readInventoryUrlState();
  syncInventoryControls();
  renderRows();
  if (normalize) writeInventoryUrlState('replaceState');
}

function normalizeAction(action) {
  return KNOWN_ACTIONS.has(action) ? action : 'HOLD';
}

function actionClass(action) {
  return `action ${normalizeAction(action)}`;
}

function statusInfo(action) {
  const normalized = normalizeAction(action);
  if (ATTENTION_ACTIONS.has(normalized)) return ['Needs action', 'attn'];
  if (normalized === 'OK') return ['Healthy', 'good'];
  return ['No velocity', ''];
}

function productMarkup(row) {
  const image = row.image_url ? `<img src="${escapeHtml(row.image_url)}" alt="" loading="lazy">` : '';

  return `${image}<div class="stock-product__copy"><div class="product-sku">${escapeHtml(row.sku)}</div><div class="product-name">${escapeHtml(row.product || row.sku)}</div></div>`;
}

function daysCover(row) {
  if (row.days_cover_with_inbound === null || row.days_cover_with_inbound === undefined) return '—';
  return Number(row.days_cover_with_inbound).toFixed(0);
}

function filteredRows() {
  const query = normalizeSearch(state.search).toLowerCase();

  return state.rows.filter((row) => {
    if (
      query &&
      !`${row.product || ''} ${row.sku || ''} ${row.canonical_sku || ''}`.toLowerCase().includes(query)
    )
      return false;
    if (state.filter === 'current' && !row.is_default_inventory) return false;
    if (state.filter === 'attention' && (!row.is_default_inventory || !ATTENTION_ACTIONS.has(row.action)))
      return false;
    if (state.filter === 'ok' && (!row.is_default_inventory || row.action !== 'OK')) return false;
    if (state.filter === 'no_velocity' && row.has_velocity) return false;
    if (state.filter === 'alias' && row.inventory_lifecycle !== 'ALIAS') return false;
    if (state.filter === 'retired' && row.inventory_lifecycle !== 'RETIRED') return false;
    if (state.filter === 'archived' && row.inventory_lifecycle !== 'ARCHIVED') return false;
    return true;
  });
}

function renderRows() {
  const rows = filteredRows();
  const tableBody = byId('rows');

  tableBody.innerHTML = rows.length
    ? rows
        .map((row) => {
          const [status, kind] = statusInfo(row.action);
          return `<tr>
            <th scope="row"><a class="stock-product" href="/product?sku=${encodeURIComponent(row.sku)}">${productMarkup(row)}</a></th>
            <td data-label="Lifecycle">${escapeHtml(LIFECYCLE_LABELS[row.inventory_lifecycle] || row.inventory_lifecycle)}</td>
            <td data-label="Canonical SKU"><span class="product-sku">${escapeHtml(row.canonical_sku || '—')}</span></td>
            <td data-label="Action"><span class="${actionClass(row.action)}">${normalizeAction(row.action)}</span></td>
            <td class="num" data-label="Available">${integer(row.available)}</td>
            <td class="num" data-label="Inbound">${integer(row.inbound)}</td>
            <td class="num" data-label="Reserved">${integer(row.reserved)}</td>
            <td class="num" data-label="28D order units">${integer(row.units_t28)}</td>
            <td class="num cover ${kind}" data-label="Days cover">${daysCover(row)}</td>
            <td data-label="Status"><span class="status-dot ${kind}">${status}</span></td>
          </tr>`;
        })
        .join('')
    : '<tr><td colspan="10"><div class="empty"><strong>No matching SKUs.</strong> Try another filter.</div></td></tr>';
}

function renderQueue() {
  const queue = state.rows.filter((row) => row.is_default_inventory && ATTENTION_ACTIONS.has(row.action));
  const queueElement = byId('queue');
  const actionSection = document.querySelector('[data-dpp-qa="inventory-actions"]');
  const coverageMap = byId('coverageMap');
  const hasExceptions = queue.length > 0;

  actionSection.dataset.queueState = hasExceptions ? 'exceptions' : 'clear';
  actionSection.dataset.queueCount = String(queue.length);
  coverageMap.open = hasExceptions;
  setText(
    'inventoryActionSummary',
    hasExceptions
      ? `${queue.length} current ${queue.length === 1 ? 'SKU deserves' : 'SKUs deserve'} a production or replenishment decision.`
      : 'No production or replenishment decisions need attention.',
  );

  queueElement.innerHTML = hasExceptions
    ? queue
        .map(
          (
            row,
          ) => `<a class="action-card ${URGENT_ACTIONS.has(row.action) ? 'urgent' : 'plan'}" href="/product?sku=${encodeURIComponent(row.sku)}">
            <div class="action-top">
              <div>
                <div class="action-sku">${escapeHtml(row.sku)}</div>
                <div class="action-name">${escapeHtml(row.product || row.sku)}</div>
              </div>
              <span class="${actionClass(row.action)}">${normalizeAction(row.action)}</span>
            </div>
            <div class="action-bottom">
              <div class="cover-big">${daysCover(row)} <span>days cover</span></div>
              <div class="stock-line">${integer(row.available)} available<br>${integer(row.inbound)} inbound · ${integer(row.units_t28)} order units / 28D</div>
            </div>
          </a>`,
        )
        .join('')
    : '<div class="queue-clear"><strong>No inventory action is queued.</strong><span>Current SKUs need no stock decision.</span></div>';
}

function renderBands(bands) {
  byId('bands').innerHTML = bands
    .map(
      (band) =>
        `<div class="band"><strong>${integer(band.sku_count)}</strong><span>${escapeHtml(band.band)}</span></div>`,
    )
    .join('');
}

function render(data) {
  const summary = data.summary || {};
  const snapshot = String(summary.latest_snapshot || '')
    .slice(0, 16)
    .replace('T', ' ');

  state.rows = data.rows || [];
  setText(
    'inventoryRecordScope',
    `${data.record_scope?.default_rows || 0} current stock-bearing offers shown by default · ${state.rows.length - Number(data.record_scope?.default_rows || 0)} reference records available by explicit filter`,
  );
  setText('clock', formatBusinessClock(data.local_time));
  setText('asof', `Snapshot ${snapshot}`);
  setText('snapshotFoot', `Snapshot ${snapshot}`);
  setText('inventoryVelocityWindow', formatMetricWindow(data.metric_windows?.INVENTORY_ORDER_VELOCITY_T28));
  setText(
    'coverPortfolio',
    summary.portfolio_days_cover === null || summary.portfolio_days_cover === undefined
      ? '—'
      : Number(summary.portfolio_days_cover).toFixed(0),
  );
  setText('available', integer(summary.available));
  setText('inbound', integer(summary.inbound));
  setText('reserved', integer(summary.reserved));

  renderQueue();
  renderBands(data.bands || []);
  renderRows();
}

function bindInteractions() {
  byId('howBtn').addEventListener('click', () => {
    const expanded = byId('how').classList.toggle('show');
    byId('howBtn').setAttribute('aria-expanded', String(expanded));
  });
  byId('search').addEventListener('input', (event) => {
    state.search = event.target.value.slice(0, MAX_SEARCH_LENGTH);
    renderRows();
    writeInventoryUrlState('replaceState');
  });

  document.querySelectorAll('.filter').forEach((button) => {
    button.addEventListener('click', () => {
      const requestedScope = button.dataset.filter;
      if (!INVENTORY_SCOPES.has(requestedScope) || requestedScope === state.filter) return;
      state.filter = requestedScope;
      syncInventoryControls();
      renderRows();
      writeInventoryUrlState();
    });
  });

  window.addEventListener('popstate', () => restoreInventoryUrlState({ normalize: true }));
}

async function start() {
  readInventoryUrlState();
  bindInteractions();
  syncInventoryControls();

  try {
    render(await fetchJson('/api/inventory'));
    writeInventoryUrlState('replaceState');
  } catch (error) {
    setText('asof', `Inventory unavailable · ${error.message}`);
  }
}

start();
