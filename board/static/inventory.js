import { byId, escapeHtml, fetchJson, integer, setText } from './ui-utils.js';

const ATTENTION_ACTIONS = new Set(['STOCKOUT', 'PRODUCE', 'PLAN']);
const URGENT_ACTIONS = new Set(['STOCKOUT', 'PRODUCE']);
const KNOWN_ACTIONS = new Set(['STOCKOUT', 'PRODUCE', 'PLAN', 'OK', 'HOLD']);

const state = {
  rows: [],
  filter: 'all',
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
    if (query && !`${row.product || ''} ${row.sku || ''}`.toLowerCase().includes(query)) return false;
    if (state.filter === 'attention' && !ATTENTION_ACTIONS.has(row.action)) return false;
    if (state.filter === 'ok' && row.action !== 'OK') return false;
    if (state.filter === 'hold' && row.action !== 'HOLD') return false;
    return true;
  });
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
            <td><a class="stock-product" href="/product?sku=${encodeURIComponent(row.sku)}">${productMarkup(row)}</a></td>
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
    : '<tr><td colspan="8"><div class="empty"><strong>No matching SKUs.</strong> Try another filter.</div></td></tr>';

  cards.innerHTML = rows.length
    ? rows
        .map(
          (row) => `<a class="inv-card" href="/product?sku=${encodeURIComponent(row.sku)}">
            <div class="stock-product">${productMarkup(row)}</div>
            <span class="${actionClass(row.action)}">${normalizeAction(row.action)}</span>
            <div class="inv-card-metrics">
              <div class="inv-card-metric"><strong>${integer(row.available)}</strong><span>Available</span></div>
              <div class="inv-card-metric"><strong>${integer(row.units_t28)}</strong><span>28D units</span></div>
              <div class="inv-card-metric"><strong>${daysCover(row)}</strong><span>Days cover</span></div>
            </div>
          </a>`,
        )
        .join('')
    : '<div class="empty"><strong>No matching SKUs.</strong></div>';
}

function renderQueue() {
  const queue = state.rows.filter((row) => ATTENTION_ACTIONS.has(row.action));
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
              <div class="stock-line">${integer(row.available)} available<br>${integer(row.inbound)} inbound · ${integer(row.units_t28)} sold / 28D</div>
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
  setText('clock', data.local_time || '--:--');
  setText('asof', `Snapshot ${snapshot}`);
  setText('snapshotFoot', `Snapshot ${snapshot}`);
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
  byId('howBtn').addEventListener('click', () => byId('how').classList.toggle('show'));
  byId('search').addEventListener('input', renderRows);

  document.querySelectorAll('.filter').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.filter').forEach((item) => item.classList.remove('active'));
      button.classList.add('active');
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
