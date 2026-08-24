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

function orderStatus(status) {
  const raw = String(status || '').trim();
  const normalized = raw.toUpperCase().replaceAll(' ', '_');
  if (['PENDING', 'PENDING_AVAILABILITY', 'INVOICE_UNCONFIRMED'].includes(normalized)) {
    return 'Amazon processing';
  }
  return raw || 'Status unavailable';
}

function orderStatusTone(status) {
  const normalized = String(status || '')
    .toUpperCase()
    .replaceAll(' ', '_');
  if (['PENDING', 'PENDING_AVAILABILITY', 'INVOICE_UNCONFIRMED'].includes(normalized)) {
    return 'waiting';
  }
  if (['SHIPPED', 'UNSHIPPED', 'PARTIALLY_SHIPPED'].includes(normalized)) return 'active';
  if (['CANCELLED', 'CANCELED'].includes(normalized)) return 'problem';
  return 'neutral';
}

function ratioPercent(value) {
  return value === null || value === undefined ? '—' : percent(100 * Number(value), { sign: false });
}

function decimal(value, digits = 2) {
  if (value === null || value === undefined) return '—';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : '—';
}

function draw() {
  if (!data || !window.DPPCharts) return;
  const rows = (data.series || []).slice(-days);
  window.DPPCharts.productDemand('#chart', rows);
  byId('chartSub').textContent =
    `Shopper spend incl. IVA · reconciled Amazon Sales & Traffic · last ${days} days`;
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
    reasons.push(
      delta == null ? 'Recent sales are active.' : `${percent(delta)} sales versus the prior 28 days.`,
    );
  } else if (Number(traffic.sessions_t28 || 0) > 0) {
    headline = 'Traffic is arriving, but units are not.';
    reasons.push(`${integer(traffic.sessions_t28)} sessions produced no recent units.`);
  } else {
    headline = 'There is little recent demand signal.';
  }

  if (conversion != null)
    reasons.push(
      `${percent(conversion, { sign: false })} conversion from ${integer(traffic.sessions_t28)} sessions.`,
    );
  if (cover != null) reasons.push(`${cover.toFixed(0)} days cover including inbound.`);

  byId('healthHeadline').textContent = headline;
  byId('healthRead').textContent = reasons.join(' ');
}

function renderHero(profile) {
  const action = profile.inventory_action || '';
  const image = profile.image_url
    ? `<img class="hero-img" src="${escapeHtml(profile.image_url)}" alt="${escapeHtml(profile.product || profile.sku || '')}">`
    : '<div class="hero-img" aria-hidden="true"></div>';
  const actionTone =
    action === 'OK' ? 'good' : action === 'STOCKOUT' || action === 'PRODUCE' ? 'bad' : 'warn';
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
  byId('inventoryState').className =
    action === 'OK'
      ? 'good'
      : action === 'PLAN'
        ? 'warn'
        : action === 'PRODUCE' || action === 'STOCKOUT'
          ? 'bad'
          : '';
  byId('inventoryNote').textContent =
    profile.days_cover_with_inbound == null
      ? 'cover unavailable'
      : `${Number(profile.days_cover_with_inbound).toFixed(0)} days cover`;

  const hasAds = Boolean(ads.through_date && Number(ads.observed_ads_days || 0) > 0);
  if (!hasAds) {
    byId('adsState').textContent = 'Ads access pending';
    byId('adsState').className = 'warn';
    byId('adsNote').textContent = 'seller demand remains available';
  } else if (ads.trusted_for_operating_decisions) {
    byId('adsState').textContent = 'Decision-grade';
    byId('adsState').className = 'good';
    byId('adsNote').textContent = `through ${String(ads.through_date).slice(5)}`;
  } else {
    byId('adsState').textContent = 'Review';
    byId('adsState').className = 'warn';
    byId('adsNote').textContent =
      `${String(ads.coverage_state || 'partial').toLowerCase()} · ${String(ads.attribution_state || 'provisional').toLowerCase()}`;
  }
}

function renderMetrics(profile, performance, traffic, economics) {
  byId('sales28').textContent = money(performance.sales_t28);
  byId('units28').textContent = integer(performance.units_t28);
  byId('delta28').textContent =
    performance.delta28_pct == null ? 'no prior baseline' : `${percent(performance.delta28_pct)} vs prior`;
  byId('sessions28').textContent = integer(traffic.sessions_t28);
  byId('cvr28').textContent = traffic.cvr_t28 == null ? '—' : percent(traffic.cvr_t28, { sign: false });
  byId('stockRead').textContent = `${integer(profile.available)} + ${integer(profile.inbound)}`;
  byId('cover').textContent =
    profile.days_cover_with_inbound == null ? '—' : Number(profile.days_cover_with_inbound).toFixed(0);
  byId('cogsRead').textContent = economics.unit_cogs == null ? '—' : `${money(economics.unit_cogs)}/unit`;
  byId('economicsNote').textContent =
    economics.estimated_cogs_t28 == null
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
  byId('econRead').textContent =
    `${economics.cogs_pct_sales_t28 == null ? '—' : percent(economics.cogs_pct_sales_t28, { sign: false })} of shopper spend incl. IVA. This excludes Amazon fees and advertising; it is not net contribution. Use Finance for ex-IVA accounting.`;
}

function renderVariationContext(profile, commercial, familyVariations) {
  const attributes = commercial.variation_attributes || {};
  byId('familyRead').textContent =
    commercial.family_name ||
    (commercial.family_asin
      ? commercial.parent_asin
        ? 'Variation family'
        : 'Commercial family'
      : 'Standalone product');

  byId('variationChips').innerHTML = Object.entries(attributes)
    .map(([key, value]) => `<span class="variation-chip">${escapeHtml(key)} · ${escapeHtml(value)}</span>`)
    .join('');

  const siblings = familyVariations || [];
  byId('siblings').innerHTML =
    siblings.length > 1
      ? siblings
          .filter((item) => item.sku !== profile.sku)
          .slice(0, 4)
          .map(
            (item) => `<a class="sibling" href="/product?sku=${encodeURIComponent(item.sku)}">
          <div>
            <strong>${escapeHtml(item.product || item.sku)}</strong>
            <span>${integer(item.units_t28)} units · ${integer(item.sessions_t28)} sessions · ${item.conversion_t28_pct == null ? '—' : percent(item.conversion_t28_pct, { sign: false })} CVR</span>
          </div>
          <b>${money(item.sales_t28)}</b>
        </a>`,
          )
          .join('')
      : '<div class="product-wait">No sibling variations to compare.</div>';
}

function renderAds(ads) {
  const observed = Number(ads.observed_ads_days || 0);
  const mature = Number(ads.mature_ads_days || 0);
  const hasAds = Boolean(ads.through_date && observed > 0);
  if (!hasAds) {
    byId('adsDecision').textContent = 'Ads integration ready';
    byId('adsRead').textContent =
      'Seller demand, conversion, inventory and COGS remain fully usable. Paid-support metrics will populate after Amazon Ads authorizes access and the initial backfill completes.';
    return;
  }

  const spend = Number(ads.spend || 0);
  const trusted = Boolean(ads.trusted_for_operating_decisions);
  const trust = trusted ? 'Decision-grade' : 'Review';
  const attribution = ads.attribution_state || (mature >= observed ? 'MATURE' : 'PROVISIONAL');
  byId('adsDecision').textContent =
    `${money(spend)} spend · ${decimal(ads.roas)}× ROAS · ${ratioPercent(ads.tacos)} TACOS`;
  byId('adsRead').textContent =
    `${money(ads.attributed_sales || 0)} Amazon-attributed sales · ${integer(ads.clicks || 0)} clicks · ${ratioPercent(ads.ctr)} CTR · ${ads.cpc == null ? '—' : money(ads.cpc)} CPC · ${ratioPercent(ads.acos)} ACOS · ${observed} observed Ads day${observed === 1 ? '' : 's'}${mature < observed ? ` · ${mature} mature` : ''}. ${trust} ${String(attribution).toLowerCase()} attribution through ${ads.through_date}. Attributed sales are not exact incremental sales, and total seller sales minus attributed sales is not exact organic sales.`;

  const healthRead = byId('healthRead');
  if (healthRead && spend > 0 && !healthRead.textContent.includes('Paid support is active')) {
    healthRead.textContent += ` Paid support is active at ${money(spend)} over 28D, with ${ratioPercent(ads.tacos)} TACOS and ${decimal(ads.roas)}× attributed ROAS; this is context, not proof of causality.`;
  }
}

function renderOrders(orders = []) {
  byId('orderSummary').textContent =
    `${orders.length} recent order${orders.length === 1 ? '' : 's'} · shopper spend incl. IVA · evidence only`;
  byId('orders').innerHTML = orders.length
    ? orders
        .map(
          (order) => `<article class="product-order">
          <div class="product-order__moment">
            <strong>${age(order.age_seconds)} ago</strong>
            <span>${escapeHtml(order.local_time || '')}</span>
            <code>${escapeHtml(order.order_short || '')}</code>
          </div>
          <div class="product-order__metric">
            <span>Units</span>
            <strong>${integer(order.units)}</strong>
          </div>
          <div class="product-order__metric product-order__spend">
            <span>Shopper spend incl. IVA</span>
            <strong>${money(order.sales)}</strong>
          </div>
          <div class="product-order__fulfillment">
            <span>Fulfillment</span>
            <strong class="order-status-pill ${orderStatusTone(order.status)}">${escapeHtml(orderStatus(order.status))}</strong>
          </div>
        </article>`,
        )
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
  document.querySelectorAll('[data-days]').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-days]').forEach((item) => {
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

  const reference = byId('productReference');
  const referenceToggle = byId('productReferenceToggle');
  const mobile = window.matchMedia('(max-width: 640px)');
  const syncReference = () => {
    reference.open = !mobile.matches;
    referenceToggle.textContent = reference.open ? 'Hide ↑' : 'View ↓';
  };
  reference.addEventListener('toggle', () => {
    referenceToggle.textContent = reference.open ? 'Hide ↑' : 'View ↓';
  });
  mobile.addEventListener('change', syncReference);
  syncReference();
}

async function start() {
  bindInteractions();

  if (!sku) {
    byId('hero').innerHTML =
      '<div class="empty"><strong>No SKU selected.</strong> Open a product from Catalog, Sales or Inventory.</div>';
    return;
  }

  try {
    render(await fetchJson(`/api/product?sku=${encodeURIComponent(sku)}`));
  } catch (error) {
    byId('hero').innerHTML =
      `<div class="empty"><strong>Product unavailable.</strong> ${escapeHtml(error.message)}</div>`;
    byId('asof').textContent = 'Feed unavailable';
  }
}

start();
