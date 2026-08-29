import {
  byId,
  escapeHtml,
  fetchJson,
  formatBusinessClock,
  formatMetricWindow,
  integer,
  setText,
} from './ui-utils.js';

const ATTENTION_ACTIONS = new Set(['STOCKOUT', 'PRODUCE', 'PLAN']);
const URGENT_ACTIONS = new Set(['STOCKOUT', 'PRODUCE']);
const KNOWN_ACTIONS = new Set(['STOCKOUT', 'PRODUCE', 'PLAN', 'OK', 'HOLD']);

const state = {
  rows: [],
  filter: 'current',
};

const LIFECYCLE_LABELS = {
  CURRENT_OFFER: 'Current offer',
  ALIAS: 'Alias',
  RETIRED: 'Retired',
  ARCHIVED: 'Archived',
};

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
  const query = byId('search').value.trim().toLowerCase();

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

function inventoryCardMarkup(row) {
  const action = normalizeAction(row.action);
  const reference = action === 'HOLD';

  return `<a class="inv-card${reference ? ' inv-card--reference' : ''}" href="/product?sku=${encodeURIComponent(row.sku)}">
    <div class="inv-card__top">
      <div class="stock-product">${productMarkup(row)}</div>
      <span class="${actionClass(action)}">${action}</span>
    </div>
    ${
      reference
        ? `<div class="inv-reference-note"><strong>${integer(row.available)}</strong> available · ${escapeHtml(LIFECYCLE_LABELS[row.inventory_lifecycle] || row.inventory_lifecycle)}${row.canonical_sku && row.canonical_sku !== row.sku ? ` · canonical ${escapeHtml(row.canonical_sku)}` : ''}</div>`
        : `<div class="inv-card-metrics">
            <div class="inv-card-metric"><strong>${integer(row.available)}</strong><span>Available</span></div>
            <div class="inv-card-metric"><strong>${integer(row.units_t28)}</strong><span>28D order units</span></div>
            <div class="inv-card-metric"><strong>${daysCover(row)}</strong><span>Days cover</span></div>
          </div>`
    }
  </a>`;
}

function mobileInventoryMarkup(rows) {
  if (!rows.length) return '<div class="empty"><strong>No matching SKUs.</strong></div>';

  const query = byId('search').value.trim();
  if (state.filter !== 'current' || query) return rows.map(inventoryCardMarkup).join('');

  const operatingRows = rows.filter((row) => normalizeAction(row.action) !== 'HOLD');
  const referenceRows = rows.filter((row) => normalizeAction(row.action) === 'HOLD');
  const operatingMarkup = operatingRows.length
    ? operatingRows.map(inventoryCardMarkup).join('')
    : '<div class="empty"><strong>No active inventory.</strong></div>';
  const referenceMarkup = referenceRows.length
    ? `<details class="inventory-reference">
        <summary><span>Reference inventory</span><strong>${referenceRows.length} no-velocity SKUs</strong></summary>
        <div class="inventory-reference__list">${referenceRows.map(inventoryCardMarkup).join('')}</div>
      </details>`
    : '';

  return `${operatingMarkup}${referenceMarkup}`;
}

function renderRows() {
  const rows = filteredRows();
  const tableBody = byId('rows');
  const cards = byId('inventoryCards');

  tableBody.innerHTML = rows.length
    ? rows
        .map((row) => {
          const [status, kind] = statusInfo(row.action);
          return `<tr>
            <th scope="row"><a class="stock-product" href="/product?sku=${encodeURIComponent(row.sku)}">${productMarkup(row)}</a></th>
            <td>${escapeHtml(LIFECYCLE_LABELS[row.inventory_lifecycle] || row.inventory_lifecycle)}</td>
            <td><span class="product-sku">${escapeHtml(row.canonical_sku || '—')}</span></td>
            <td><span class="${actionClass(row.action)}">${normalizeAction(row.action)}</span></td>
            <td class="num">${integer(row.available)}</td>
            <td class="num">${integer(row.inbound)}</td>
            <td class="num">${integer(row.reserved)}</td>
            <td class="num">${integer(row.units_t28)}</td>
            <td class="num cover ${kind}">${daysCover(row)}</td>
            <td><span class="status-dot ${kind}">${status}</span></td>
          </tr>`;
        })
        .join('')
    : '<tr><td colspan="10"><div class="empty"><strong>No matching SKUs.</strong> Try another filter.</div></td></tr>';

  cards.innerHTML = mobileInventoryMarkup(rows);
}

function renderQueue() {
  const queue = state.rows.filter((row) => row.is_default_inventory && ATTENTION_ACTIONS.has(row.action));
  const queueElement = byId('queue');

  queueElement.innerHTML = queue.length
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
    : '<div class="empty queue-empty"><strong>Nothing urgent.</strong> No active selling SKU currently needs a stock intervention.</div>';
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
  byId('search').addEventListener('input', renderRows);

  document.querySelectorAll('.filter').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.filter').forEach((item) => {
        item.classList.remove('active');
        item.setAttribute('aria-pressed', 'false');
      });
      button.classList.add('active');
      button.setAttribute('aria-pressed', 'true');
      state.filter = button.dataset.filter;
      renderRows();
    });
  });
}

async function start() {
  bindInteractions();

  try {
    render(await fetchJson('/api/inventory'));
  } catch (error) {
    setText('asof', `Inventory unavailable · ${error.message}`);
  }
}

start();
