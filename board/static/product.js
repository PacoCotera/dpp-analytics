import { byId, escapeHtml, fetchJson, integer, money, percent } from './ui-utils.js';

const sku = new URLSearchParams(window.location.search).get('sku') || '';
let data = null;
let days = 28;

function age(seconds) {
  const value = Number(seconds || 0);
  if (value < 3600) return `${Math.max(1, Math.round(value / 60))}m`;
  if (value < 86400) return `${(value / 3600).toFixed(value < 10800 ? 1 : 0)}h`;
  return `${(value / 86400).toFixed(value < 259200 ? 1 : 0)}d`;
}

function draw() {
  if (!data || !window.DPPCharts) return;
  const rows = (data.series || []).slice(-days);
  window.DPPCharts.productDemand('#chart', rows);
  byId('chartSub').textContent = `Daily sales and seven-day demand signal · last ${days} days`;
}

function renderHealth(payload) {
  const performance = payload.performance || {};
  const traffic = payload.traffic || {};
  const profile = payload.profile || {};
  const commercial = payload.commercial || {};
  const delta = performance.delta28_pct == null ? null : Number(performance.delta28_pct);
  const cover = profile.days_cover_with_inbound == null ? null : Number(profile.days_cover_with_inbound);
  const conversion = traffic.cvr_t28 == null ? null : Number(traffic.cvr_t28);
  const sellable = commercial.listing_sellable !== false;
  const reasons = [];
  let headline = 'Product is stable.';

  if (!sellable) {
    headline = 'Listing is not currently sellable.';
    reasons.push('Demand interpretation is secondary until listing state is resolved.');
  } else if (profile.inventory_action === 'STOCKOUT') {
    headline = 'Demand is being constrained by stock.';
    reasons.push('The offer is stocked out.');
  } else if (profile.inventory_action === 'PRODUCE') {
    headline = 'Replenishment is the immediate priority.';
    reasons.push('Inventory cover is below two weeks at recent velocity.');
  } else if (delta != null && delta >= 20) {
    headline = 'Demand is accelerating.';
    reasons.push(`${percent(delta)} sales versus the prior 28 days.`);
  } else if (delta != null && delta <= -20) {
    headline = 'Demand has softened materially.';
    reasons.push(`${percent(delta)} sales versus the prior 28 days.`);
  } else if (Number(performance.units_t28 || 0) > 0) {
    headline = 'Product is selling without a major exception.';
    reasons.push(delta == null ? 'Recent sales are active.' : `${percent(delta)} sales versus the prior 28 days.`);
  } else if (Number(traffic.sessions_t28 || 0) > 0) {
    headline = 'Traffic is arriving, but units are not.';
    reasons.push(`${integer(traffic.sessions_t28)} sessions produced no recent units.`);
  } else {
    headline = 'There is little recent demand signal.';
  }

  if (conversion != null) reasons.push(`${percent(conversion, { sign: false })} conversion from ${integer(traffic.sessions_t28)} sessions.`);
  if (cover != null) reasons.push(`${cover.toFixed(0)} days cover including inbound.`);

  byId('healthHeadline').textContent = headline;
  byId('healthRead').textContent = reasons.join(' ');
}

function renderHero(profile) {
  const action = profile.inventory_action || '';
  const image = profile.image_url
    ? `<img class="hero-img" src="${escapeHtml(profile.image_url)}" alt="${escapeHtml(profile.product || profile.sku || '')}">`
    : '<div class="hero-img" aria-hidden="true"></div>';
  const actionTone = action === 'OK' ? 'good' : action === 'STOCKOUT' || action === 'PRODUCE' ? 'bad' : 'warn';
  const chips = [
    action ? `<span class="chip ${actionTone}">${escapeHtml(action)}</span>` : '',
    profile.listing_status ? `<span class="chip">${escapeHtml(profile.listing_status)}</span>` : '',
  ].join('');
  const amazonLink = profile.amazon_url
    ? `<a class="btn" href="${escapeHtml(profile.amazon_url)}" target="_blank" rel="noopener">Amazon ↗</a>`
    : '';

  byId('hero').innerHTML = `${image}
    <div>
      <div class="hero-sku">${escapeHtml(profile.sku)} · ${escapeHtml(profile.asin || '')}</div>
      <div class="hero-name">${escapeHtml(profile.product || profile.sku)}</div>
      <div class="hero-details">${chips}</div>
    </div>
    <div class="hero-price">
      <strong>${profile.listing_price == null ? '—' : money(profile.listing_price)}</strong>
      <span>listing price</span>
      ${amazonLink}
    </div>`;
}

function renderListingAndInventory(profile, commercial, ads) {
  const sellable = commercial.listing_sellable !== false;
  byId('listingState').textContent = sellable ? 'Sellable' : 'Not sellable';
  byId('listingState').className = sellable ? 'good' : 'bad';
  byId('listingNote').textContent = profile.listing_status || 'listing state';

  const attributes = commercial.variation_attributes || {};
  const attributeValues = Object.values(attributes);
  byId('variationRead').textContent = attributeValues.length
    ? attributeValues.join(' · ')
    : commercial.product_role === 'SELLABLE_STANDALONE'
      ? 'Standalone'
      : '—';
  byId('variationNote').textContent = commercial.parent_asin ? 'child variation' : 'commercial offer';

  const action = profile.inventory_action || '—';
  byId('inventoryState').textContent = action;
  byId('inventoryState').className = action === 'OK' ? 'good' : action === 'PLAN' ? 'warn' : action === 'PRODUCE' || action === 'STOCKOUT' ? 'bad' : '';
  byId('inventoryNote').textContent = profile.days_cover_with_inbound == null
    ? 'cover unavailable'
    : `${Number(profile.days_cover_with_inbound).toFixed(0)} days cover`;

  const adsReady = ads.status === 'ready';
  byId('adsState').textContent = adsReady ? 'Available' : 'Pending';
  byId('adsNote').textContent = adsReady ? 'attribution may revise' : 'Ads data not yet available';
}

function renderMetrics(profile, performance, traffic, economics) {
  byId('sales28').textContent = money(performance.sales_t28);
  byId('units28').textContent = integer(performance.units_t28);
  byId('delta28').textContent = performance.delta28_pct == null
    ? 'no prior baseline'
    : `${percent(performance.delta28_pct)} vs prior`;
  byId('sessions28').textContent = integer(traffic.sessions_t28);
  byId('cvr28').textContent = traffic.cvr_t28 == null ? '—' : percent(traffic.cvr_t28, { sign: false });
  byId('stockRead').textContent = `${integer(profile.available)} + ${integer(profile.inbound)}`;
  byId('cover').textContent = profile.days_cover_with_inbound == null ? '—' : Number(profile.days_cover_with_inbound).toFixed(0);
  byId('cogsRead').textContent = economics.unit_cogs == null ? '—' : `${money(economics.unit_cogs)}/unit`;
  byId('economicsNote').textContent = economics.estimated_cogs_t28 == null
    ? 'standard COGS missing'
    : `${money(economics.estimated_cogs_t28)} estimated 28D COGS`;
}

function renderInventoryDecision(profile) {
  byId('available').textContent = integer(profile.available);
  byId('inbound').textContent = integer(profile.inbound);
  byId('velocity').textContent = Number(profile.units_per_day || 0).toFixed(2);

  let decision = 'Inventory is stable.';
  let read = 'Coverage is healthy at the current selling velocity.';

  if (profile.inventory_action === 'STOCKOUT') {
    decision = 'Replenish now.';
    read = 'Stocked out with recent demand.';
  } else if (profile.inventory_action === 'PRODUCE') {
    decision = 'Production is urgent.';
    read = 'Less than 14 days cover including inbound.';
  } else if (profile.inventory_action === 'PLAN') {
    decision = 'Plan replenishment.';
    read = '14–27 days cover including inbound.';
  } else if (profile.inventory_action !== 'OK') {
    decision = 'Review before producing.';
    read = 'Recent velocity is not strong enough for a confident replenishment read.';
  }

  byId('invDecision').textContent = decision;
  byId('invRead').textContent = read;
}

function renderEconomicsDecision(economics) {
  if (economics.unit_cogs == null) {
    byId('econDecision').textContent = 'COGS not configured';
    byId('econRead').textContent = 'Add standard product cost before using product-level economics.';
    return;
  }

  byId('econDecision').textContent = `${money(economics.estimated_cogs_t28)} estimated COGS · 28D`;
  byId('econRead').textContent = `${economics.cogs_pct_sales_t28 == null ? '—' : percent(economics.cogs_pct_sales_t28, { sign: false })} of sales. This excludes Amazon fees and advertising; it is not net contribution.`;
}

function renderVariationContext(profile, commercial, familyVariations) {
  const attributes = commercial.variation_attributes || {};
  byId('familyRead').textContent = commercial.family_asin
    ? commercial.parent_asin
      ? 'Variation family'
      : 'Commercial family'
    : 'Standalone product';

  byId('variationChips').innerHTML = Object.entries(attributes)
    .map(([key, value]) => `<span class="variation-chip">${escapeHtml(key)} · ${escapeHtml(value)}</span>`)
    .join('');

  const siblings = familyVariations || [];
  byId('siblings').innerHTML = siblings.length > 1
    ? siblings
        .filter(item => item.sku !== profile.sku)
        .slice(0, 4)
        .map(item => `<a class="sibling" href="/product?sku=${encodeURIComponent(item.sku)}">
          <div>
            <strong>${escapeHtml(item.product || item.sku)}</strong>
            <span>${integer(item.units_t28)} units · ${integer(item.sessions_t28)} sessions · ${item.conversion_t28_pct == null ? '—' : percent(item.conversion_t28_pct, { sign: false })} CVR</span>
          </div>
          <b>${money(item.sales_t28)}</b>
        </a>`)
        .join('')
    : '<div class="product-wait">No sibling variations to compare.</div>';
}

function renderAds(ads) {
  if (ads.status === 'ready') {
    byId('adsDecision').textContent = `${money(ads.spend_t28)} spend · ${ads.roas_t28 == null ? '—' : `${Number(ads.roas_t28).toFixed(2)}×`} ROAS`;
    byId('adsRead').textContent = `TACOS ${ads.tacos_t28 == null ? '—' : percent(100 * Number(ads.tacos_t28), { sign: false })}. Attributed sales are not exact incremental or organic sales.`;
    return;
  }

  byId('adsDecision').textContent = 'Paid-support context pending';
  byId('adsRead').textContent = 'Seller demand remains readable without Ads. Paid attribution will appear here when the Ads feed is available.';
}

function renderOrders(orders = []) {
  byId('orderSummary').textContent = `${orders.length} recent order${orders.length === 1 ? '' : 's'} · evidence only`;
  byId('orders').innerHTML = orders.length
    ? orders
        .map(order => `<div class="list-row">
          <div class="order-age">${age(order.age_seconds)}</div>
          <div>
            <div class="row-title">${escapeHtml(order.local_time || '')}</div>
            <div class="order-id">${escapeHtml(order.order_short || '')}</div>
          </div>
          <div class="row-value">
            <strong>${money(order.sales)}</strong>
            <small>${integer(order.units)} units · ${escapeHtml(order.status || '')}</small>
          </div>
        </div>`)
        .join('')
    : '<div class="empty"><strong>No recent orders.</strong></div>';
}

function render(payload) {
  data = payload;
  const profile = payload.profile || {};
  const performance = payload.performance || {};
  const traffic = payload.traffic || {};
  const commercial = payload.commercial || {};
  const economics = payload.economics || {};
  const ads = payload.ads || {};

  document.title = `${profile.product || profile.sku || 'Product'} · DPP`;
  byId('clock').textContent = payload.local_time || '--:--';
  byId('asof').textContent = `Historical through ${String(payload.business_date || '').slice(5)}`;

  renderHero(profile);
  renderHealth(payload);
  renderListingAndInventory(profile, commercial, ads);
  renderMetrics(profile, performance, traffic, economics);
  renderInventoryDecision(profile);
  renderEconomicsDecision(economics);
  renderVariationContext(profile, commercial, payload.family_variations);
  renderAds(ads);
  renderOrders(payload.recent_orders);
  draw();
}

function bindInteractions() {
  document.querySelectorAll('[data-days]').forEach(button => {
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-days]').forEach(item => {
        item.classList.remove('active');
        item.setAttribute('aria-selected', 'false');
      });
      button.classList.add('active');
      button.setAttribute('aria-selected', 'true');
      days = Number(button.dataset.days);
      draw();
    });
  });

  byId('ordersPanel').addEventListener('toggle', () => {
    byId('orderToggle').textContent = byId('ordersPanel').open ? 'Hide ↑' : 'View ↓';
  });
}

async function start() {
  bindInteractions();

  if (!sku) {
    byId('hero').innerHTML = '<div class="empty"><strong>No SKU selected.</strong> Open a product from Catalog, Sales or Inventory.</div>';
    return;
  }

  try {
    render(await fetchJson(`/api/product?sku=${encodeURIComponent(sku)}`));
  } catch (error) {
    byId('hero').innerHTML = `<div class="empty"><strong>Product unavailable.</strong> ${escapeHtml(error.message)}</div>`;
    byId('asof').textContent = 'Feed unavailable';
  }
}

start();
