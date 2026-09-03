import {
  adsDestination,
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
const PRODUCT_WINDOWS = new Set(['28d', '90d', 'ytd']);
const PRODUCT_METRICS = new Set(['sales', 'units']);
let data = null;
let productWindow = '28d';
let metric = 'sales';
let ordersExpanded = false;
const ORDER_PREVIEW_LIMIT = 6;

function readProductUrlState() {
  const params = new URLSearchParams(window.location.search);
  const requestedWindow = params.get('window') || '28d';
  const requestedMetric = params.get('metric') || 'sales';
  productWindow = PRODUCT_WINDOWS.has(requestedWindow) ? requestedWindow : '28d';
  metric = PRODUCT_METRICS.has(requestedMetric) ? requestedMetric : 'sales';
}

function writeProductUrlState(method = 'pushState') {
  const url = new URL(window.location.href);
  if (productWindow === '28d') url.searchParams.delete('window');
  else url.searchParams.set('window', productWindow);
  if (metric === 'sales') url.searchParams.delete('metric');
  else url.searchParams.set('metric', metric);
  window.history[method]({}, '', url);
}

function syncProductControls() {
  document.querySelectorAll('[data-days]').forEach((button) => {
    const buttonWindow = button.dataset.days === 'ytd' ? 'ytd' : `${button.dataset.days}d`;
    const active = buttonWindow === productWindow;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  document.querySelectorAll('[data-metric]').forEach((button) => {
    const active = button.dataset.metric === metric;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function restoreProductUrlState({ normalize = false } = {}) {
  readProductUrlState();
  syncProductControls();
  if (normalize) writeProductUrlState('replaceState');
  draw();
}

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
  return percent(value, { scale: 100, sign: false });
}

function decimal(value, digits = 2) {
  if (value === null || value === undefined) return '—';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : '—';
}

function draw() {
  if (!data || !window.DPPCharts) return;
  const series = data.series || [];
  let rows;
  if (productWindow === 'ytd') {
    const year = String(series.at(-1)?.business_date || '').slice(0, 4);
    rows = year ? series.filter((row) => String(row.business_date || '').startsWith(year)) : series;
  } else {
    rows = series.slice(-Number.parseInt(productWindow, 10));
  }
  window.DPPCharts.productDemand('#chart', rows, { metric });
  const windowLabel =
    productWindow === 'ytd' ? 'year to date' : `last ${Number.parseInt(productWindow, 10)} days`;
  byId('chartSub').textContent =
    metric === 'units'
      ? `Units ordered · reconciled Amazon Sales & Traffic · ${windowLabel}`
      : `Shopper spend incl. IVA · reconciled Amazon Sales & Traffic · ${windowLabel}`;
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
  const details = [
    action ? `<span class="chip ${actionTone}">${escapeHtml(action)}</span>` : '',
    profile.listing_status ? `<span class="chip">${escapeHtml(profile.listing_status)}</span>` : '',
    identity.family_label || commercial.family_name
      ? `<span class="hero-meta">${escapeHtml(identity.family_label || commercial.family_name)}</span>`
      : '',
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
      <h1 class="page-lead__title hero-name">${escapeHtml(profile.product || profile.sku)}</h1>
    </div>
    <div class="hero-price">
      <strong>${profile.listing_price == null ? '—' : money(profile.listing_price)}</strong>
      <span>${deleted ? 'last listing price' : 'listing price'}</span>
      ${amazonLink}
    </div>
    <div class="hero-command">
      <div class="hero-signal">
        <div class="page-lead__read"><strong id="healthHeadline">Reading the product…</strong></div>
        <p class="page-lead__description" id="healthRead">Connecting demand, traffic, availability, listing state and economics.</p>
      </div>
      <div class="product-lead-evidence">
        <details class="page-lead__evidence">
          <summary>Listing details</summary>
          ${profile.catalog_title && profile.catalog_title !== profile.product ? `<p class="hero-catalog-title">${escapeHtml(profile.catalog_title)}</p>` : ''}
          <div class="hero-details">${details}</div>
          <p>${escapeHtml(identity.role || commercial.product_role || 'Commercial identity')}</p>
        </details>
        <details class="page-lead__evidence">
          <summary>Data basis</summary>
          <p class="metric-window-note" id="productDemandWindow">Loading product-demand window</p>
          <p class="metric-window-note" id="productVelocityWindow">Loading inventory-velocity window</p>
        </details>
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
    byId('adsState').className = connection.degraded
      ? 'warn'
      : connection.state === 'READY'
        ? 'good'
        : connection.state === 'FAILED'
          ? 'bad'
          : 'warn';
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
  const module = byId('productAdsModule');
  module.hidden = true;
  if (commercial.catalog_membership === 'DELETED') {
    byId('adsDecision').textContent = 'No current Ads decision';
    byId('adsRead').textContent =
      'Deleted SKUs are excluded from current paid-support decisions; order history remains available.';
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
  const attribution = ads.attribution_state || (mature >= observed ? 'MATURE' : 'PROVISIONAL');
  const recommendation = ads.recommendation || {};
  const action = ads.action || {};
  byId('adsDecision').textContent =
    recommendation.label || (trusted ? 'Paid-support context is ready' : 'Paid-support context needs review');
  byId('adsRead').textContent =
    `${recommendation.title || 'Review this product’s paid support.'} ${recommendation.explanation || ''}`;

  module.hidden = false;
  byId('productAdsWindow').textContent =
    `${String(ads.period_start || '').slice(0, 10)} to ${String(ads.through_date).slice(0, 10)} · ${String(attribution).toLowerCase()} attribution`;
  byId('productAdsImpressions').textContent = integer(ads.impressions);
  byId('productAdsClicks').textContent = integer(ads.clicks);
  byId('productAdsPurchases').textContent = integer(ads.attributed_purchases);
  byId('productAdsAttributedSales').textContent = money(ads.attributed_sales);
  byId('productAdsMetrics').innerHTML = [
    ['Seller sales', money(ads.total_business_sales)],
    ['Ad spend', money(ads.spend)],
    ['TACOS', ratioPercent(ads.tacos)],
    ['CTR · CPC', `${ratioPercent(ads.ctr)} · ${ads.cpc == null ? '—' : money(ads.cpc)}`],
    ['Conversion', ratioPercent(ads.conversion_rate)],
    ['ROAS · ACOS', `${decimal(ads.roas)}× · ${ratioPercent(ads.acos)}`],
  ]
    .map(
      ([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`,
    )
    .join('');
  byId('productAdsActionLabel').textContent = recommendation.label || 'Review';
  byId('productAdsRecommendation').textContent = recommendation.title || 'Review paid support';
  byId('productAdsRecommendationRead').textContent = recommendation.explanation || '';
  byId('productAdsSteps').innerHTML = (action.review_steps || [])
    .map((step) => `<li>${escapeHtml(step)}</li>`)
    .join('');
  byId('productAdsQualification').textContent = action.qualification || ads.economics?.basis || '';
  byId('productAdsActionLink').href = adsDestination(
    action.destination || { view: 'products', sku: ads.sku },
  );
  byId('productAdsDemandLink').href = adsDestination({ view: 'demand', sku: ads.sku });
  byId('productAdsNote').textContent =
    `${formatCount(observed, 'observed Ads day')} · ${formatCount(mature, 'mature day')} · through ${String(ads.through_date).slice(0, 10)}. Amazon-attributed sales are not incremental sales. Seller sales minus attributed sales is not exact organic sales.`;

  const healthRead = byId('healthRead');
  if (healthRead && spend > 0 && !healthRead.textContent.includes('Paid support is active')) {
    healthRead.textContent += ` Paid support is active at ${money(spend)} over 28D, with ${ratioPercent(ads.tacos)} TACOS and ${decimal(ads.roas)}× attributed ROAS; this is context, not proof of causality.`;
  }
}

function renderOrders(orders = [], profile = {}) {
  byId('orderSummary').textContent =
    `${formatCount(orders.length, 'recent order')} · shopper spend incl. IVA`;
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

  byId('clock').textContent = formatBusinessClock(payload.local_time);
  byId('asof').textContent = `Historical through ${String(payload.business_date || '').slice(5)}`;
  renderHero(profile, commercial);
  byId('productDemandWindow').textContent = formatMetricWindow(
    payload.metric_windows?.RECONCILED_PRODUCT_T28,
  );
  byId('productVelocityWindow').textContent = formatMetricWindow(
    payload.metric_windows?.INVENTORY_ORDER_VELOCITY_T28,
  );

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
      const requestedWindow = button.dataset.days === 'ytd' ? 'ytd' : `${button.dataset.days}d`;
      if (!PRODUCT_WINDOWS.has(requestedWindow) || requestedWindow === productWindow) return;
      productWindow = requestedWindow;
      syncProductControls();
      writeProductUrlState();
      draw();
    });
  });

  document.querySelectorAll('[data-metric]').forEach((button) => {
    button.addEventListener('click', () => {
      const requestedMetric = button.dataset.metric;
      if (!PRODUCT_METRICS.has(requestedMetric) || requestedMetric === metric) return;
      metric = requestedMetric;
      syncProductControls();
      writeProductUrlState();
      draw();
    });
  });

  window.addEventListener('popstate', () => restoreProductUrlState({ normalize: true }));

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
  if (!sku) {
    renderEmptyWorkspace();
    return;
  }

  restoreProductUrlState({ normalize: true });
  bindInteractions();

  try {
    render(await fetchJson(`/api/product?sku=${encodeURIComponent(sku)}`));
  } catch (error) {
    renderEmptyWorkspace({
      title: 'Product unavailable',
      description: error.message,
    });
    byId('asof').textContent = 'Feed unavailable';
  }
}

function renderEmptyWorkspace({
  title = 'Choose a product',
  description = 'Open a product from Catalog, Sales or Inventory to see its demand, stock and decisions.',
} = {}) {
  document.body.classList.add('product-page--empty');
  const hero = byId('hero');
  hero.classList.add('product-hero--empty');
  hero.setAttribute('aria-labelledby', 'productEmptyTitle');
  hero.innerHTML = `<div class="product-empty-state">
    <div class="section-label">Product workspace</div>
    <h1 class="page-lead__title" id="productEmptyTitle">${escapeHtml(title)}</h1>
    <p class="page-lead__description">${escapeHtml(description)}</p>
    <nav class="product-empty-actions" aria-label="Choose a product source">
      <a class="btn" href="/catalog">Browse Products</a>
      <a class="btn" href="/sales">Open Sales</a>
      <a class="btn" href="/inventory">Open Inventory</a>
    </nav>
  </div>`;
  byId('asof').textContent = 'Select a product';
}

start();
