import { byId, escapeHtml, fetchJson, integer, money } from './ui-utils.js';

let lastPayload = null;
let lastQuery = null;
let loadingQuery = null;

function queryKey() {
  return new URLSearchParams(window.location.search).get('date') || '';
}

function age(seconds) {
  const value = Number(seconds || 0);
  if (value < 3600) return `${Math.max(1, Math.round(value / 60))}m`;
  if (value < 86400) return `${(value / 3600).toFixed(value < 10800 ? 1 : 0)}h`;
  return `${(value / 86400).toFixed(1)}d`;
}

function statusLabel(status) {
  const key = String(status || '').toUpperCase();
  return (
    {
      PENDING: 'Pending',
      PENDING_AVAILABILITY: 'Pending availability',
      INVOICE_UNCONFIRMED: 'Invoice unconfirmed',
      UNSHIPPED: 'Unshipped',
      PARTIALLY_SHIPPED: 'Partially shipped',
      SHIPPED: 'Shipped',
      CANCELLED: 'Cancelled',
      UNFULFILLABLE: 'Unfulfillable',
    }[key] || key.replaceAll('_', ' ').toLowerCase() || 'Unknown'
  );
}

function statusTone(status) {
  const key = String(status || '').toUpperCase();
  if (['PENDING', 'PENDING_AVAILABILITY', 'INVOICE_UNCONFIRMED'].includes(key)) return 'pending';
  if (['UNSHIPPED', 'PARTIALLY_SHIPPED', 'SHIPPED'].includes(key)) return 'active';
  if (['UNFULFILLABLE', 'CANCELLED'].includes(key)) return 'problem';
  return '';
}

function fulfillmentLabel(order) {
  if (order.fulfillment_model && order.fulfillment_model !== '—') return order.fulfillment_model;
  const fulfilledBy = String(order.fulfilled_by || '').toUpperCase();
  if (fulfilledBy === 'AMAZON') return 'FBA';
  if (fulfilledBy === 'MERCHANT') return 'FBM';
  return '—';
}

function renderOrderCard(order) {
  const items = order.items || [];
  const itemHtml = items.length
    ? items
        .map((item) => {
          const image = item.image_url
            ? `<img src="${escapeHtml(item.image_url)}" alt="">`
            : '<span class="item-image-placeholder"></span>';
          const identity = [item.sku ? `SKU ${item.sku}` : '', item.asin ? `ASIN ${item.asin}` : '']
            .filter(Boolean)
            .join(' · ');
          return `<div class="operational-order__item">
            ${image}
            <div>
              <div class="item-name">${escapeHtml(item.product || item.sku || item.asin || 'Item')}</div>
              <div class="item-identity">${escapeHtml(identity || 'Identity unavailable')}</div>
              <div class="item-id">Item ${escapeHtml(item.order_item_id || '—')}</div>
            </div>
            <div class="item-qty">×${integer(item.quantity_ordered || 0)}</div>
          </div>`;
        })
        .join('')
    : `<div class="operational-order__item"><span class="item-image-placeholder"></span><div><div class="item-name">${escapeHtml(order.product || order.sku || 'Order')}</div><div class="item-identity">${escapeHtml([order.sku ? `SKU ${order.sku}` : '', order.asin ? `ASIN ${order.asin}` : ''].filter(Boolean).join(' · ') || 'Item detail pending')}</div></div><div class="item-qty">×${integer(order.units || 0)}</div></div>`;

  const status = statusLabel(order.status);
  const fulfillment = fulfillmentLabel(order);
  const total = order.sales === null || order.sales === undefined ? '—' : money(order.sales);
  const timing = [order.local_time || '', order.age_seconds !== null && order.age_seconds !== undefined ? age(order.age_seconds) : '']
    .filter(Boolean)
    .join(' · ');
  const fulfilled = Number(order.quantity_fulfilled || 0);
  const unfulfilled = Number(order.quantity_unfulfilled || 0);
  const channel = order.channel_name || 'Amazon';

  return `<article class="today-order operational-order ops-owned">
    <div class="operational-order__top">
      <div class="operational-order__badges">
        <span class="order-badge ${statusTone(order.status)}">${escapeHtml(status)}</span>
        <span class="order-badge fulfillment">${escapeHtml(fulfillment)}</span>
      </div>
      <strong>${total}</strong>
    </div>
    <div class="operational-order__meta">
      <code>${escapeHtml(order.order_id || 'Order ID unavailable')}</code>
      <span>${escapeHtml(timing)}</span>
    </div>
    <div class="operational-order__items">${itemHtml}</div>
    <div class="operational-order__foot">
      <span>${integer(order.units || items.reduce((sum, item) => sum + Number(item.quantity_ordered || 0), 0))} units · ${fulfilled} fulfilled · ${unfulfilled} unfulfilled</span>
      <span>${escapeHtml(channel)} · shopper spend incl. IVA</span>
    </div>
  </article>`;
}

function renderOrderFlow(payload) {
  const flow = payload.order_flow || payload.today?.order_flow || null;
  if (!flow) {
    byId('openOrdersKpi').textContent = '—';
    byId('openOrdersKpiNote').textContent = 'current queue';
    byId('orderFlowGrid').innerHTML = '<div class="empty ops-owned">Current order queue is shown on live Today.</div>';
    byId('orderFlowFoot').textContent = 'Operational status is current state, not selected-day history.';
    byId('openOrderSummary').textContent = 'Current order queue is not attached to historical day views';
    byId('openOrderGrid').innerHTML = '<div class="empty ops-owned">Open orders are available on live Today.</div>';
    return;
  }

  const open = Number(flow.open_orders || 0);
  const fba = Number(flow.fba_open_orders || 0);
  const fbm = Number(flow.fbm_open_orders || 0);
  const unknown = Number(flow.unknown_fulfillment_open_orders || 0);

  byId('openOrdersKpi').textContent = integer(open);
  byId('openOrdersKpiNote').textContent = open
    ? `FBA ${fba} · FBM ${fbm}${unknown ? ` · ${unknown} other` : ''}`
    : 'queue clear';

  byId('orderFlowGrid').innerHTML = [
    ['Open', flow.open_orders],
    ['Pending', flow.pending_orders],
    ['Unshipped', flow.unshipped_orders],
    ['Shipped today', flow.shipped_today],
  ]
    .map(
      ([label, value]) => `<div class="order-flow-stat"><strong>${integer(value || 0)}</strong><span>${label}</span></div>`,
    )
    .join('');

  const notes = [`Current state · FBA ${fba} · FBM ${fbm}${unknown ? ` · ${unknown} other` : ''}`];
  if (Number(flow.partially_shipped_orders || 0)) notes.push(`${integer(flow.partially_shipped_orders)} partial`);
  if (Number(flow.problem_orders || 0)) notes.push(`${integer(flow.problem_orders)} needs attention`);
  byId('orderFlowFoot').textContent = notes.join(' · ');

  const openOrders = payload.open_orders || payload.today?.open_orders || [];
  byId('openOrderSummary').textContent = open
    ? `${open} open · ${fba} FBA · ${fbm} FBM · current Amazon fulfillment state`
    : 'No open Amazon orders';
  byId('openOrderGrid').innerHTML = openOrders.length
    ? openOrders.map(renderOrderCard).join('')
    : '<div class="empty ops-owned">No open orders.</div>';
}

function renderSelectedOrders(payload) {
  const orders = payload.recent_orders || [];
  const today = payload.today || {};
  byId('orderSummary').textContent = `${integer(today.orders_today || 0)} orders · ${integer(today.units_today || 0)} units · ${money(today.sales_today || 0)} shopper spend incl. IVA`;
  byId('orderGrid').innerHTML = orders.length
    ? orders.map(renderOrderCard).join('')
    : '<div class="empty ops-owned">No orders recorded for this day.</div>';
}

function renderProducts(payload) {
  const products = payload.sku_today || [];
  const totalSales = Number(payload.today?.sales_today || 0);
  const live = Boolean(payload.is_live);
  byId('productsTitle').textContent = live ? 'What is driving today' : 'What drove that day';
  byId('products').innerHTML = products.length
    ? products
        .slice(0, 8)
        .map((item) => {
          const image = item.image_url ? `<img src="${escapeHtml(item.image_url)}" alt="">` : '';
          const contribution = totalSales > 0 ? (100 * Number(item.sales || 0)) / totalSales : 0;
          const identity = [item.sku ? `SKU ${item.sku}` : '', item.asin ? `ASIN ${item.asin}` : '']
            .filter(Boolean)
            .join(' · ');
          return `<a class="today-product ops-owned" href="/product?sku=${encodeURIComponent(item.sku || '')}">
            ${image}
            <div>
              <div class="name">${escapeHtml(item.product || item.sku || item.asin || 'Product')}</div>
              <div class="product-identity">${escapeHtml(identity)}</div>
              <div class="meta">${integer(item.units || 0)} units · ${integer(item.orders || 0)} orders</div>
              <div class="share-track"><i style="width:${Math.max(2, Math.min(100, contribution))}%"></i></div>
            </div>
            <div class="value">${money(item.sales || 0)}<span class="share">${contribution.toFixed(0)}% of shopper spend</span></div>
          </a>`;
        })
        .join('')
    : `<div class="empty ops-owned">${live ? 'Products will appear as orders arrive.' : 'No product sales recorded for this day.'}</div>`;
}

function renderAll() {
  if (!lastPayload) return;
  renderOrderFlow(lastPayload);
  renderSelectedOrders(lastPayload);
  renderProducts(lastPayload);
}

async function loadOperations() {
  const key = queryKey();
  if (loadingQuery === key) return;
  loadingQuery = key;
  try {
    const query = key ? `?date=${encodeURIComponent(key)}` : '';
    lastPayload = await fetchJson(`/api/today${query}`);
    lastQuery = key;
    renderAll();
  } catch (error) {
    if (byId('orderFlowFoot')) byId('orderFlowFoot').textContent = `Order operations unavailable: ${error.message}`;
  } finally {
    loadingQuery = null;
  }
}

function keepOperationalOwner(nodeId, render) {
  const node = byId(nodeId);
  if (!node || !window.MutationObserver) return;
  new MutationObserver(() => {
    const key = queryKey();
    if (key !== lastQuery) {
      loadOperations();
      return;
    }
    if (lastPayload && !node.querySelector('.ops-owned')) render(lastPayload);
  }).observe(node, { childList: true });
}

const openPanel = byId('openOrdersPanel');
if (openPanel) {
  openPanel.addEventListener('toggle', () => {
    byId('openOrderToggle').textContent = openPanel.open ? 'Hide ↑' : 'View ↓';
  });
}

window.addEventListener('popstate', loadOperations);
keepOperationalOwner('orderGrid', renderSelectedOrders);
keepOperationalOwner('products', renderProducts);

window.setTimeout(loadOperations, 0);
window.setInterval(loadOperations, 20000);
