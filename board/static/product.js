import {
  byId,
  escapeHtml,
  fetchJson,
  formatBusinessClock,
  formatCount,
  formatMetricWindow,
  integer,
  money,
  mountRuleTrigger,
  percent,
} from './ui-utils.js';

const sku = new URLSearchParams(window.location.search).get('sku') || '';
let data = null;
let days = 28;
let metric = 'sales';
let ordersExpanded = false;
const ORDER_PREVIEW_LIMIT = 6;

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

function fulfillmentLabel(order) {
  if (order.fulfillment_model) return order.fulfillment_model;
  const fulfilledBy = String(order.fulfilled_by || '').toUpperCase();
  if (fulfilledBy === 'AMAZON') return 'FBA';
  if (fulfilledBy === 'MERCHANT') return 'FBM';
  return 'Amazon';
}

function listedDate(value) {
  if (!value) return 'date unavailable';
  const parsed = new Date(`${String(value).slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? String(value)
    : new Intl.DateTimeFormat('en', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(parsed);
}

function ratioPercent(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return percent(100 * Number(value), { sign: false });
}

function decimal(value, digits = 2) {
  if (value === null || value === undefined) return '—';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : '—';
}

function draw() {
  if (!data || !window.DPPCharts) return;
  const rows = (data.series || []).slice(-days);
  window.DPPCharts.productDemand('#chart', rows, { metric });
  byId('chartSub').textContent =
    metric === 'units'
      ? `Units ordered · reconciled Amazon Sales & Traffic · last ${days} days`
      : `Shopper spend incl. IVA · reconciled Amazon Sales & Traffic · last ${days} days`;
}

function renderHealth(payload) {
  const traffic = payload.traffic || {};
  const profile = payload.profile || {};
  const commercial = payload.commercial || {};
  const cover = profile.days_cover_with_inbound == null ? null : Number(profile.days_cover_with_inbound);
  const conversion = traffic.cvr_t28 == null ? null : Number(traffic.cvr_t28);
  const read = commercial.commercial_evaluation || {};
  const reasons = commercial.commercial_explanation ? [commercial.commercial_explanation] : [];

  if (conversion != null)
    reasons.push(
      `${percent(conversion, { sign: false })} conversion from ${integer(traffic.sessions_t28)} sessions.`,
    );
  if (cover != null) reasons.push(`${cover.toFixed(0)} days cover including inbound.`);

  byId('healthHeadline').textContent = read.label || 'Product state unavailable';
  byId('healthRead').textContent = reasons.join(' ');
  mountRuleTrigger(byId('healthHeadline'), read, payload.interpretation_rules);
}

function renderHero(profile, commercial) {
  const action = profile.inventory_action || '';
  const image = profile.image_url
    ? `<img class="hero-img" src="${escapeHtml(profile.image_url)}" alt="${escapeHtml(profile.product || profile.sku || '')}">`
    : '<div class="hero-img" aria-hidden="true"></div>';
  const actionTone =
    action === 'OK' ? 'good' : action === 'STOCKOUT' || action === 'PRODUCE' ? 'bad' : 'warn';
  const attributes = Object.values(commercial.variation_attributes || {});
  const identity = commercial.identity || {};
  const deleted = commercial.catalog_membership === 'DELETED';
  const fulfillment = String(profile.fulfillment_channel || '')
    .toUpperCase()
    .includes('AMAZON')
    ? 'FBA'
    : profile.fulfillment_channel || 'Fulfillment unavailable';
  const chips = [
    action ? `<span class="chip ${actionTone}">${escapeHtml(action)}</span>` : '',
    profile.listing_status ? `<span class="chip">${escapeHtml(profile.listing_status)}</span>` : '',
    commercial.family_name ? `<span class="hero-meta">${escapeHtml(commercial.family_name)}</span>` : '',
    attributes.length ? `<span class="hero-meta">${escapeHtml(attributes.join(' · '))}</span>` : '',
    commercial.parent_asin
      ? `<span class="hero-meta">Parent ${escapeHtml(commercial.parent_asin)}</span>`
      : '',
    `<span class="hero-meta">${deleted ? 'Last reported ' : ''}${escapeHtml(fulfillment)}</span>`,
    `<span class="hero-meta">${deleted ? 'Last listed' : 'Listed'} ${escapeHtml(listedDate(profile.open_date))}</span>`,
  ].join('');
  const amazonLink = profile.amazon_url
    ? `<a class="btn" href="${escapeHtml(profile.amazon_url)}" target="_blank" rel="noopener">Amazon ↗</a>`
    : '';

  byId('hero').innerHTML = `${image}
    <div>
      <div class="hero-sku">${escapeHtml(profile.sku)} · ${escapeHtml(profile.asin || '')}</div>
      <h1 class="hero-name">${escapeHtml(profile.product || profile.sku)}</h1>
      ${profile.catalog_title && profile.catalog_title !== profile.product ? `<div class="hero-catalog-title">${escapeHtml(profile.catalog_title)}</div>` : ''}
      <div class="hero-details">${chips}</div>
    </div>
    <div class="hero-price">
      <strong>${profile.listing_price == null ? '—' : money(profile.listing_price)}</strong>
      <span>${deleted ? 'last listing price' : 'listing price'}</span>
      ${amazonLink}
    </div>
    <div class="hero-command">
      <div class="hero-signal">
        <div class="product-health__kicker">Product health</div>
        <strong id="healthHeadline">Reading the product…</strong>
        <p id="healthRead">Connecting demand, traffic, availability, listing state and economics.</p>
      </div>
      <div class="product-health__facts">
        <div class="product-health__fact"><div class="label">Listing</div><strong>${escapeHtml(profile.listing_status || '—')}</strong><small>${profile.listing_status === 'Deleted' ? `Last Amazon status ${escapeHtml(profile.source_listing_status || 'unknown')}` : escapeHtml(fulfillment)}</small></div>
        <div class="product-health__fact"><div class="label">Family</div><strong>${escapeHtml(identity.family_label || 'Identity unavailable')}</strong><small>${escapeHtml(identity.role || commercial.product_role || 'commercial identity')}</small></div>
        <div class="product-health__fact"><div class="label">Variation</div><strong>${escapeHtml(attributes.slice(0, 2).join(' · ') || '—')}</strong><small>${escapeHtml(attributes.slice(2).join(' · ') || commercial.amazon_variation_theme || 'catalog attributes')}</small></div>
        <div class="product-health__fact"><div class="label">Parent ASIN</div><strong>${escapeHtml(commercial.parent_asin || 'None')}</strong><small>${deleted ? (commercial.parent_asin ? 'last known Amazon family' : 'historical relationship unavailable') : commercial.parent_asin ? 'Amazon variation family' : 'standalone offer'}</small></div>
      </div>
    </div>`;
}

function renderListingAndInventory(profile, commercial, ads) {
  const sellable = commercial.listing_sellable !== false;
  const deleted = commercial.catalog_membership === 'DELETED';
  byId('listingState').textContent = deleted ? 'Deleted' : sellable ? 'Sellable' : 'Not sellable';
  byId('listingState').className = deleted ? 'warn' : sellable ? 'good' : 'bad';
  byId('listingNote').textContent =
    profile.listing_status === 'Deleted'
      ? `Last Amazon status ${profile.source_listing_status || 'unknown'}`
      : profile.listing_status || 'listing state';

  const attributes = commercial.variation_attributes || {};
  const attributeValues = Object.values(attributes);
  byId('variationRead').textContent = attributeValues.length
    ? attributeValues.join(' · ')
    : deleted
      ? 'Historical record'
      : commercial.product_role === 'SELLABLE_STANDALONE'
        ? 'Standalone'
        : '—';
  byId('variationNote').textContent = deleted
    ? 'not a current offer'
    : commercial.parent_asin
      ? 'child variation'
      : 'commercial offer';

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

  const connection = ads.connection || {};
  if (deleted) {
    byId('adsState').textContent = 'Historical only';
    byId('adsState').className = 'warn';
    byId('adsNote').textContent = 'not a current offer';
  } else {
    byId('adsState').textContent = connection.badge || 'Ads state unavailable';
    byId('adsState').className =
      connection.state === 'READY' ? 'good' : connection.state === 'FAILED' ? 'bad' : 'warn';
    byId('adsNote').textContent = connection.note || 'connection state unavailable';
  }
}

function renderMetrics(profile, performance, traffic, economics) {
  byId('sales28').textContent = money(performance.sales_t28);
  byId('units28').textContent = integer(performance.units_t28);
  byId('delta28').textContent =
    performance.delta28_pct == null ? 'no prior baseline' : `${percent(performance.delta28_pct)} vs prior`;
  const delta = Number(performance.delta28_pct);
  byId('delta28').className =
    performance.delta28_pct == null ? 'warn' : delta > 0 ? 'good' : delta < 0 ? 'bad' : '';
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

function renderInventoryDecision(profile, commercial) {
  byId('available').textContent = integer(profile.available);
  byId('inbound').textContent = integer(profile.inbound);
  byId('velocity').textContent = Number(profile.units_per_day || 0).toFixed(2);

  let decision = 'Inventory is stable.';
  let read = 'Coverage is healthy at the current selling velocity.';
  let tone = 'healthy';

  if (commercial.catalog_membership === 'DELETED') {
    decision = 'No current inventory decision.';
    read = 'Deleted SKUs are excluded from replenishment decisions.';
    tone = 'neutral';
  } else if (profile.inventory_action === 'STOCKOUT') {
    decision = 'Replenish now.';
    read = 'Stocked out with recent demand.';
    tone = 'critical';
  } else if (profile.inventory_action === 'PRODUCE') {
    decision = 'Production is urgent.';
    read = 'Less than 14 days cover including inbound.';
    tone = 'critical';
  } else if (profile.inventory_action === 'PLAN') {
    decision = 'Plan replenishment.';
    read = '14–27 days cover including inbound.';
    tone = 'warning';
  } else if (profile.inventory_action !== 'OK') {
    decision = 'Review before producing.';
    read = 'Recent velocity is not strong enough for a confident replenishment read.';
    tone = 'neutral';
  }

  byId('invDecision').closest('.decision-block').dataset.tone = tone;
  byId('invDecision').textContent = decision;
  byId('invRead').textContent = read;
}

function renderEconomicsDecision(economics, commercial) {
  if (commercial.catalog_membership === 'DELETED') {
    byId('econDecision').textContent = 'Historical record';
    byId('econRead').textContent = 'Deleted SKUs are excluded from current product economics decisions.';
    return;
  }
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
  const identity = commercial.identity || {};
  byId('familyRead').textContent = identity.family_label || 'Identity unavailable';

  byId('variationChips').innerHTML = Object.entries(attributes)
    .map(([key, value]) => `<span class="variation-chip">${escapeHtml(key)} · ${escapeHtml(value)}</span>`)
    .join('');
  byId('variationIdentity').textContent = [
    commercial.parent_asin ? `Parent ${commercial.parent_asin}` : '',
    commercial.asin ? `ASIN ${commercial.asin}` : '',
    commercial.amazon_variation_theme ? `Theme ${commercial.amazon_variation_theme}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const siblings = familyVariations || [];
  byId('siblings').innerHTML =
    siblings.length > 1
      ? siblings
          .filter((item) => item.sku !== profile.sku)
          .slice(0, 4)
          .map(
            (item) => `<a class="sibling" href="/product?sku=${encodeURIComponent(item.sku)}">
          ${item.image_url ? `<img src="${escapeHtml(item.image_url)}" alt="">` : '<span class="sibling-image-placeholder"></span>'}
          <div>
            <strong>${escapeHtml(item.product || item.sku)}</strong>
            <span>${formatCount(item.units_t28, 'unit')} · ${formatCount(item.sessions_t28, 'session')} · ${item.conversion_t28_pct == null ? '—' : percent(item.conversion_t28_pct, { sign: false })} CVR</span>
            <b>${money(item.sales_t28)}</b>
          </div>
        </a>`,
          )
          .join('')
      : '<div class="product-wait">No sibling variations to compare.</div>';
}

function renderAds(ads, commercial) {
  if (commercial.catalog_membership === 'DELETED') {
    byId('adsDecision').textContent = 'No current Ads decision';
    byId('adsRead').textContent =
      'Deleted SKUs are excluded from current paid-support decisions; historical order evidence remains available.';
    return;
  }
  const connection = ads.connection || {};
  const observed = Number(ads.observed_ads_days || 0);
  const mature = Number(ads.mature_ads_days || 0);
  const hasAds = Boolean(ads.through_date && observed > 0);
  byId('adsDecision').textContent = connection.headline || 'Amazon Ads state is unavailable.';
  byId('adsRead').textContent =
    connection.detail || 'The current Amazon Ads connection state could not be read.';
  if (connection.state !== 'READY' || !hasAds) {
    return;
  }

  const spend = Number(ads.spend || 0);
  const trusted = Boolean(ads.trusted_for_operating_decisions);
  const trust = trusted ? 'Decision-grade' : 'Review';
  const attribution = ads.attribution_state || (mature >= observed ? 'MATURE' : 'PROVISIONAL');
  byId('adsRead').textContent =
    `${connection.detail} Current product read: ${money(spend)} spend · ${money(ads.attributed_sales || 0)} Amazon-attributed sales · ${formatCount(ads.clicks, 'click')} · ${ratioPercent(ads.ctr)} CTR · ${ads.cpc == null ? '—' : money(ads.cpc)} CPC · ${ratioPercent(ads.acos)} ACOS · ${decimal(ads.roas)}× ROAS · ${ratioPercent(ads.tacos)} TACOS · ${formatCount(observed, 'observed Ads day')}${mature < observed ? ` · ${mature} mature` : ''}. ${trust} ${String(attribution).toLowerCase()} attribution through ${ads.through_date}. Attributed sales are not exact incremental sales, and total seller sales minus attributed sales is not exact organic sales.`;

  const healthRead = byId('healthRead');
  if (healthRead && spend > 0 && !healthRead.textContent.includes('Paid support is active')) {
    healthRead.textContent += ` Paid support is active at ${money(spend)} over 28D, with ${ratioPercent(ads.tacos)} TACOS and ${decimal(ads.roas)}× attributed ROAS; this is context, not proof of causality.`;
  }
}

function renderOrders(orders = [], profile = {}) {
  byId('orderSummary').textContent =
    `${formatCount(orders.length, 'recent order')} · shopper spend incl. IVA · evidence only`;
  byId('orders').innerHTML = orders.length
    ? orders
        .map((order, index) => {
          const image = profile.image_url
            ? `<img src="${escapeHtml(profile.image_url)}" alt="">`
            : '<span class="product-order__image-placeholder"></span>';
          return `<article class="product-order${index >= ORDER_PREVIEW_LIMIT ? ' reference-order' : ''}">
          <div class="product-order__top">
            <div class="product-order__badges">
              <span class="order-status-pill ${orderStatusTone(order.status)}">${escapeHtml(orderStatus(order.status))}</span>
              <span class="order-badge fulfillment">${escapeHtml(fulfillmentLabel(order))}</span>
            </div>
            <strong>${money(order.sales)}</strong>
          </div>
          <div class="product-order__meta">
            <code>${escapeHtml(order.order_id || order.order_short || 'Order ID unavailable')}</code>
            <span>${escapeHtml(order.local_time ? formatBusinessClock(order.local_time) : '')} · ${age(order.age_seconds)} ago</span>
          </div>
          <div class="product-order__item">
            ${image}
            <div>
              <div class="product-order__item-name">${escapeHtml(profile.product || profile.sku || 'Product')}</div>
              <div class="product-order__item-id">${escapeHtml([profile.sku ? `SKU ${profile.sku}` : '', profile.asin ? `ASIN ${profile.asin}` : ''].filter(Boolean).join(' · '))}</div>
            </div>
            <div class="product-order__qty">×${integer(order.units)}</div>
          </div>
          <div class="product-order__foot">
            <span>${formatCount(order.units, 'unit')} · ${escapeHtml(orderStatus(order.status))}</span>
            <span>${escapeHtml(order.channel_name || 'Amazon')} · shopper spend incl. IVA</span>
          </div>
        </article>`;
        })
        .join('')
    : '<div class="empty"><strong>No recent orders.</strong></div>';
  const hidden = Math.max(0, orders.length - ORDER_PREVIEW_LIMIT);
  byId('ordersMore').hidden = hidden === 0;
  byId('ordersMoreCount').textContent = hidden ? `${hidden} more` : '';
  ordersExpanded = false;
  byId('orders').classList.remove('orders-expanded');
  byId('ordersMore').setAttribute('aria-expanded', 'false');
  byId('ordersMoreLabel').textContent = 'Show all recent orders';
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
  byId('clock').textContent = formatBusinessClock(payload.local_time);
  byId('asof').textContent = `Historical through ${String(payload.business_date || '').slice(5)}`;
  byId('productDemandWindow').textContent = formatMetricWindow(
    payload.metric_windows?.RECONCILED_PRODUCT_T28,
  );
  byId('productVelocityWindow').textContent = formatMetricWindow(
    payload.metric_windows?.INVENTORY_ORDER_VELOCITY_T28,
  );

  renderHero(profile, commercial);
  renderHealth(payload);
  renderListingAndInventory(profile, commercial, ads);
  renderMetrics(profile, performance, traffic, economics);
  renderInventoryDecision(profile, commercial);
  renderEconomicsDecision(economics, commercial);
  renderVariationContext(profile, commercial, payload.family_variations);
  renderAds(ads, commercial);
  renderOrders(payload.recent_orders, profile);
  draw();
}

function bindInteractions() {
  document.querySelectorAll('[data-days]').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-days]').forEach((item) => {
        item.classList.remove('active');
        item.setAttribute('aria-pressed', 'false');
      });
      button.classList.add('active');
      button.setAttribute('aria-pressed', 'true');
      days = Number(button.dataset.days);
      draw();
    });
  });

  document.querySelectorAll('[data-metric]').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-metric]').forEach((item) => {
        item.classList.remove('active');
        item.setAttribute('aria-pressed', 'false');
      });
      button.classList.add('active');
      button.setAttribute('aria-pressed', 'true');
      metric = button.dataset.metric || 'sales';
      draw();
    });
  });

  byId('ordersPanel').addEventListener('toggle', () => {
    byId('orderToggle').textContent = byId('ordersPanel').open ? 'Hide ↑' : 'View ↓';
  });

  byId('ordersMore').addEventListener('click', () => {
    ordersExpanded = !ordersExpanded;
    byId('orders').classList.toggle('orders-expanded', ordersExpanded);
    byId('ordersMore').setAttribute('aria-expanded', String(ordersExpanded));
    byId('ordersMoreLabel').textContent = ordersExpanded ? 'Show fewer orders' : 'Show all recent orders';
    byId('ordersMoreCount').textContent = ordersExpanded
      ? 'all shown'
      : `${Math.max(0, Number(data?.recent_orders?.length || 0) - ORDER_PREVIEW_LIMIT)} more`;
  });

  const reference = byId('productReference');
  const referenceToggle = byId('productReferenceToggle');
  reference.addEventListener('toggle', () => {
    referenceToggle.textContent = reference.open ? 'Hide ↑' : 'View ↓';
  });
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
