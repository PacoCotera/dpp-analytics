import {
  byId,
  escapeHtml,
  fetchJson,
  formatBusinessClock,
  formatCount,
  integer,
  money,
  percent,
} from './ui-utils.js';
import { loadAdsChartDependencies } from './ads-chart-loader.js';

const VIEWS = new Set(['impact', 'products', 'demand', 'detail']);
const ACTION_STATES = new Set([
  'needs_attention',
  'opportunity_test',
  'supported_monitor',
  'no_current_action',
]);
const PRODUCT_SORTS = new Set(['decision', 'spend-desc', 'sales-desc', 'tacos-desc']);
const DEMAND_SORTS = new Set(['decision', 'spend-desc', 'sales-desc', 'purchases-desc']);
const SIGNAL_TYPES = new Set(['shopper_query', 'matched_product', 'target']);
const STATE_KEYS = ['sku', 'campaign', 'signal', 'action', 'filter', 'sort', 'page', 'q', 'signalType'];

let DATA = null;
let requestSequence = 0;
let searchTimer = 0;

const ratioPercent = (value) => percent(value, { scale: 100, sign: false });
const deltaPercent = (value) => percent(value);
const deltaPoints = (value) => (value == null ? '—' : percent(value).replace('%', ' pts'));
const multiple = (value) => (value == null ? '—' : `${Number(value).toFixed(2)}×`);
const safeText = (value, fallback = '—') =>
  value === null || value === undefined || value === '' ? fallback : value;

function setMetric(id, value) {
  const element = byId(id);
  if (element) element.textContent = value;
}

function stateFromUrl() {
  const url = new URL(window.location.href);
  const rawView = url.searchParams.get('view') || 'impact';
  const view = VIEWS.has(rawView) ? rawView : 'impact';
  const filterValue = (url.searchParams.get('filter') || '').toLowerCase();
  const sortValue = (url.searchParams.get('sort') || '').toLowerCase();
  const typeValue = (url.searchParams.get('signal_type') || '').toLowerCase();
  const pageValue = Number.parseInt(url.searchParams.get('page') || '1', 10);
  return {
    view,
    sku: (url.searchParams.get('sku') || '').slice(0, 120),
    campaign: (url.searchParams.get('campaign') || '').slice(0, 160),
    signal: (url.searchParams.get('signal') || '').slice(0, 160),
    action: (url.searchParams.get('action') || '').slice(0, 160),
    filter: ACTION_STATES.has(filterValue) ? filterValue : '',
    sort:
      view === 'products'
        ? PRODUCT_SORTS.has(sortValue)
          ? sortValue
          : 'decision'
        : DEMAND_SORTS.has(sortValue)
          ? sortValue
          : 'decision',
    page: Number.isFinite(pageValue) && pageValue > 0 ? pageValue : 1,
    q: (url.searchParams.get('q') || '').trim().slice(0, 120),
    signalType: SIGNAL_TYPES.has(typeValue) ? typeValue : '',
  };
}

function canonicalizeUrl(state, { replace = true } = {}) {
  const url = new URL(window.location.href);
  if (state.view === 'impact') url.searchParams.delete('view');
  else url.searchParams.set('view', state.view);
  const values = {
    sku: state.sku,
    campaign: state.campaign,
    signal: state.signal,
    action: state.action,
    filter: state.filter,
    sort: state.sort === 'decision' ? '' : state.sort,
    page: state.page > 1 ? String(state.page) : '',
    q: state.q,
    signal_type: state.signalType,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  const method = replace ? 'replaceState' : 'pushState';
  history[method]({}, '', `${url.pathname}${url.search}${url.hash}`);
}

function changeState(patch, { replace = false, clear = [], load = true } = {}) {
  const state = stateFromUrl();
  for (const key of clear) state[key] = key === 'page' ? 1 : '';
  Object.assign(state, patch);
  canonicalizeUrl(state, { replace });
  if (load && DATA?.status === 'ready') loadData();
  else applyViewState();
}

function queryForApi() {
  const state = stateFromUrl();
  const params = new URLSearchParams();
  for (const key of ['sku', 'campaign', 'signal', 'filter', 'sort', 'page', 'q']) {
    const value = key === 'page' ? (state.page > 1 ? state.page : '') : state[key];
    if (value) params.set(key, value);
  }
  if (state.signalType) params.set('signal_type', state.signalType);
  return params.size ? `/api/ads?${params}` : '/api/ads';
}

function issueLabel(value) {
  const labels = {
    ACCOUNT_MARKETPLACE_MISSING: 'account marketplace mapping',
    CURRENCY_MISMATCH: 'currency mismatch',
    CAMPAIGN_GRAIN_MISSING: 'campaign report missing',
    PRODUCT_GRAIN_MISSING: 'advertised-product report missing',
    ACCOUNT_ROLLUP_INCONSISTENT: 'account rollup inconsistency',
    INDEPENDENT_REPORT_VALUE_MISMATCH: 'campaign/product value mismatch',
    ATTRIBUTION_CONTRACT_MISMATCH: 'attribution contract mismatch',
    SELLER_SALES_DENOMINATOR_MISSING: 'seller-sales denominator missing',
  };
  return (
    labels[value] ||
    String(value || '')
      .toLowerCase()
      .replaceAll('_', ' ')
  );
}

function renderReadiness(payload) {
  const quality = payload.quality || {};
  const freshness = payload.freshness || {};
  const readiness = payload.readiness || {};
  const trusted = Boolean(quality.trusted_for_operating_decisions);
  const badge = byId('qualityBadge');
  const line = byId('qualityBand');
  badge.className = `ads-quality-badge ${trusted ? 'trusted' : quality.state === 'ATTENTION' ? 'attention' : 'nodata'}`;
  line.dataset.state = trusted ? 'trusted' : quality.state === 'ATTENTION' ? 'attention' : 'nodata';
  if (trusted) {
    badge.textContent = 'Ready for review';
    byId('qualityTitle').textContent = 'Reporting is reconciled.';
    byId('qualityCopy').textContent =
      'Recent Amazon-attributed conversions remain provisional until their lookback window closes.';
  } else if (quality.state === 'ATTENTION') {
    badge.textContent = 'Use with caution';
    byId('qualityTitle').textContent = 'Reporting needs verification.';
    const issues = (quality.issues || [])
      .slice(0, 3)
      .map((issue) => `${issueLabel(issue.quality_state)} (${integer(issue.days)}d)`)
      .join(', ');
    byId('qualityCopy').textContent = issues || 'Actions are suppressed until reconciliation is healthy.';
  } else {
    badge.textContent = 'Still validating';
    byId('qualityTitle').textContent = 'The operating window is not ready.';
    byId('qualityCopy').textContent =
      'Actions are suppressed until coverage and reconciliation are complete.';
  }
  byId('readinessLabel').textContent = readiness.label || badge.textContent;
  byId('readinessLine').textContent = readiness.summary || 'Reporting readiness unavailable';
  setMetric(
    'coverageRead',
    `${Number(freshness.period_observed_days || 0)}/${formatCount(Number(freshness.period_expected_days || 28), 'day')}`,
  );
  setMetric(
    'maturityRead',
    `${Number(freshness.mature_days || 0)}/${formatCount(Number(freshness.period_observed_days || 28), 'day')}`,
  );
  setMetric(
    'qualityIssueRead',
    quality.issue_days ? formatCount(quality.issue_days, 'day') : quality.state === 'HEALTHY' ? 'none' : '—',
  );
}

function actionMetricText(action) {
  const metrics = action.metrics || {};
  return [
    metrics.spend != null ? `${money(metrics.spend)} spend` : '',
    metrics.clicks != null ? `${integer(metrics.clicks)} clicks` : '',
    metrics.purchases != null ? `${integer(metrics.purchases)} attributed purchases` : '',
    metrics.tacos != null ? `${ratioPercent(metrics.tacos)} TACOS` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function renderAction(action) {
  const maturity = action.maturity || {};
  const product = action.product || action.sku || 'Advertising evidence';
  const image = action.image_url
    ? `<span class="product-thumb-well"><img class="product-thumb" src="${escapeHtml(action.image_url)}" alt="" loading="lazy"></span>`
    : '';
  const steps = (action.review_steps || []).map((step) => `<li>${escapeHtml(step)}</li>`).join('');
  return `<article class="ads-action-card" data-action-id="${escapeHtml(action.id)}">
    <div class="ads-action-product">${image}<div><span class="ads-state-label">${escapeHtml(action.label || 'Review')}</span><strong>${escapeHtml(product)}</strong>${action.sku ? `<span>${escapeHtml(action.sku)}</span>` : ''}</div></div>
    <div class="ads-action-body"><h3>${escapeHtml(action.title || 'Review advertising evidence')}</h3><p>${escapeHtml(action.rationale || '')}</p><div class="ads-action-metrics">${escapeHtml(actionMetricText(action))}</div>${steps ? `<details><summary>Review steps</summary><ol>${steps}</ol></details>` : ''}<div class="ads-action-qualification">${escapeHtml(action.qualification || '')}</div></div>
    <button class="ads-action-open" type="button" data-review-action="${escapeHtml(action.id)}">Review</button>
  </article>`;
}

function renderActions(payload) {
  const section = byId('actionSection');
  const host = byId('actionGroups');
  const groups = (payload.action_groups || []).filter((group) => (group.actions || []).length);
  if (!groups.length) {
    section.hidden = true;
    host.innerHTML = '';
    return;
  }
  section.hidden = false;
  byId('actionCount').textContent = String((payload.actions || []).length);
  host.innerHTML = groups
    .map(
      (group) =>
        `<section class="ads-action-lane" aria-labelledby="lane-${escapeHtml(group.key)}"><div class="ads-action-lane-head"><h3 id="lane-${escapeHtml(group.key)}">${escapeHtml(group.label)}</h3><span>${group.shown} of ${group.total}</span></div>${(group.actions || []).map(renderAction).join('')}</section>`,
    )
    .join('');
  host.querySelectorAll('[data-review-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = (payload.actions || []).find((item) => item.id === button.dataset.reviewAction);
      if (!action) return;
      const destination = action.destination || {};
      changeState(
        {
          view: destination.view || 'impact',
          sku: destination.sku || '',
          campaign: destination.campaign || '',
          signal: destination.signal || '',
          action: destination.action || action.id,
          filter: destination.filter || '',
          page: 1,
        },
        { clear: ['sort', 'q', 'signalType'] },
      );
    });
  });
}

function renderPortfolio(products) {
  const host = byId('portfolioList');
  host.innerHTML = products.length
    ? products
        .slice(0, 5)
        .map(
          (product) =>
            `<a href="/product?sku=${encodeURIComponent(product.sku)}"><span><strong>${escapeHtml(product.product || product.sku)}</strong><small>${escapeHtml(product.sku || '')}</small></span><span>${money(product.total_business_sales)} seller sales</span><span>${money(product.spend)} spend</span><span>${ratioPercent(product.tacos)} TACOS</span><span class="ads-state-label">${escapeHtml(product.recommendation?.label || 'Monitor')}</span></a>`,
        )
        .join('')
    : '<p>No advertised products are available for this window.</p>';
}

function renderFunnel(summary) {
  const stages = [
    ['Impressions', integer(summary.impressions)],
    ['Clicks', integer(summary.clicks), `CTR ${ratioPercent(summary.ctr)}`],
    [
      'Attributed purchases',
      integer(summary.purchases),
      `Conversion ${ratioPercent(summary.conversion_rate)}`,
    ],
    ['Attributed units', integer(summary.units)],
  ];
  byId('funnel').innerHTML = `<ol>${stages
    .map(
      ([label, value, rate]) =>
        `<li><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${rate ? `<small>${escapeHtml(rate)}</small>` : ''}</li>`,
    )
    .join('')}</ol>`;
}

function productIdentity(product) {
  const image = product.image_url
    ? `<span class="product-thumb-well"><img class="product-thumb" src="${escapeHtml(product.image_url)}" alt="" loading="lazy"></span>`
    : '';
  return `<a class="product-line" href="/product?sku=${encodeURIComponent(product.sku)}">${image}<span><strong>${escapeHtml(product.product || product.sku || product.asin || 'Unknown product')}</strong><small>${escapeHtml(product.sku || product.asin || '')}</small></span></a>`;
}

function filteredProducts() {
  const state = stateFromUrl();
  let products = [...(DATA?.products || [])];
  if (state.sku) products = products.filter((product) => String(product.sku || '') === state.sku);
  if (state.filter) {
    products = products.filter(
      (product) => String(product.recommendation?.state || '').toLowerCase() === state.filter,
    );
  }
  if (state.q) {
    const query = state.q.toLowerCase();
    products = products.filter((product) =>
      `${product.product || ''} ${product.sku || ''} ${product.asin || ''}`.toLowerCase().includes(query),
    );
  }
  if (state.sort === 'spend-desc') products.sort((a, b) => Number(b.spend || 0) - Number(a.spend || 0));
  if (state.sort === 'sales-desc') {
    products.sort((a, b) => Number(b.total_business_sales || 0) - Number(a.total_business_sales || 0));
  }
  if (state.sort === 'tacos-desc') products.sort((a, b) => Number(b.tacos ?? -1) - Number(a.tacos ?? -1));
  return products;
}

function renderProducts() {
  const products = filteredProducts();
  byId('productCount').textContent = formatCount(products.length, 'product');
  byId('productRows').innerHTML = products.length
    ? products
        .map((product) => {
          const recommendation = product.recommendation || {};
          const highlighted = stateFromUrl().sku === String(product.sku || '');
          return `<tr data-sku="${escapeHtml(product.sku || '')}"${highlighted ? ' class="is-highlighted"' : ''}>
            <th scope="row"><div class="ads-product-primary">${productIdentity(product)}<span class="ads-state-label">${escapeHtml(recommendation.label || 'Monitor')}</span><span>${escapeHtml(recommendation.title || '')}</span>${recommendation.suppression_reason ? `<small>${escapeHtml(recommendation.suppression_reason)}</small>` : ''}</div></th>
            <td data-label="Seller sales" class="ads-num">${money(product.total_business_sales)}</td>
            <td data-label="Ad spend" class="ads-num">${money(product.spend)}</td>
            <td data-label="TACOS" class="ads-num">${ratioPercent(product.tacos)}</td>
            <td data-label="Attributed sales" class="ads-num">${money(product.attributed_sales)}</td>
            <td data-label="Attributed share" class="ads-num">${ratioPercent(product.attributed_sales_share)}</td>
            <td data-label="Impressions" class="ads-num">${integer(product.impressions)}</td>
            <td data-label="Clicks" class="ads-num">${integer(product.clicks)}</td>
            <td data-label="CTR" class="ads-num">${ratioPercent(product.ctr)}</td>
            <td data-label="CPC" class="ads-num">${money(product.cpc)}</td>
            <td data-label="Purchases / units" class="ads-num">${integer(product.purchases)} / ${integer(product.units)}</td>
            <td data-label="Conversion" class="ads-num">${ratioPercent(product.conversion_rate)}</td>
            <td data-label="ROAS / ACOS" class="ads-num">${multiple(product.roas)} / ${ratioPercent(product.acos)}</td>
            <td data-label="Maturity" class="ads-num">${integer(product.mature_ads_days)} / ${integer(product.observed_ads_days)} days</td>
          </tr>`;
        })
        .join('')
    : '<tr><td colspan="14">No products match the current filters.</td></tr>';
}

function productReference(signal) {
  const references = signal.product_refs || [];
  if (references.length === 1) return productIdentity(references[0]);
  if (references.length > 1) {
    const names = references
      .slice(0, 3)
      .map((reference) => escapeHtml(reference.product || reference.sku))
      .join(', ');
    return `<div class="ads-multi-product"><strong>${references.length} associated products</strong><span>${names}${references.length > 3 ? '…' : ''}</span></div>`;
  }
  return '<span class="ads-muted">Product association unavailable</span>';
}

function technicalDetails(signal) {
  const technical = signal.technical || {};
  return `<details class="ads-technical"><summary>Technical details</summary><dl>
    <div><dt>Campaign ID</dt><dd>${escapeHtml(safeText(technical.campaign_id))}</dd></div>
    <div><dt>Ad group ID</dt><dd>${escapeHtml(safeText(technical.ad_group_id))}</dd></div>
    <div><dt>Target ID</dt><dd>${escapeHtml(safeText(technical.target_id))}</dd></div>
    <div><dt>Raw value</dt><dd>${escapeHtml(safeText(technical.raw_value))}</dd></div>
    <div><dt>Raw match type</dt><dd>${escapeHtml(safeText(technical.raw_match_type))}</dd></div>
  </dl></details>`;
}

function renderDemand() {
  const demand = DATA?.demand || { items: [], total: 0, page: 1, page_count: 1 };
  const state = stateFromUrl();
  byId('demandCount').textContent = formatCount(demand.total || 0, 'signal');
  byId('demandPage').textContent = `Page ${demand.page || 1} of ${demand.page_count || 1}`;
  byId('demandPrev').disabled = Number(demand.page || 1) <= 1;
  byId('demandNext').disabled = Number(demand.page || 1) >= Number(demand.page_count || 1);
  byId('demandRows').innerHTML = (demand.items || []).length
    ? demand.items
        .map((signal) => {
          const recommendation = signal.recommendation || {};
          const highlighted = state.signal === signal.signal_id;
          return `<tr data-signal-id="${escapeHtml(signal.signal_id)}"${highlighted ? ' class="is-highlighted"' : ''}>
            <td data-label="Product">${productReference(signal)}</td>
            <th scope="row"><div class="ads-signal"><span>${escapeHtml(signal.signal_type_label || 'Demand signal')}</span><strong>${escapeHtml(signal.signal || 'Unnamed signal')}</strong><small>${escapeHtml(signal.match_label || '')} · ${escapeHtml(signal.campaign_name || 'Campaign unavailable')}</small>${technicalDetails(signal)}</div></th>
            <td data-label="Review state"><span class="ads-state-label">${escapeHtml(recommendation.label || 'Monitor')}</span><span>${escapeHtml(recommendation.explanation || '')}</span></td>
            <td data-label="Spend" class="ads-num">${money(signal.spend)}</td>
            <td data-label="Clicks" class="ads-num">${integer(signal.clicks)}</td>
            <td data-label="Purchases" class="ads-num">${integer(signal.purchases)}</td>
            <td data-label="Attributed sales" class="ads-num">${money(signal.attributed_sales)}</td>
            <td data-label="ROAS / ACOS" class="ads-num">${multiple(signal.roas)} / ${ratioPercent(signal.acos)}</td>
            <td data-label="Review"><button type="button" class="ads-row-action" data-inspect-signal="${escapeHtml(signal.signal_id)}">Inspect</button></td>
          </tr>`;
        })
        .join('')
    : '<tr><td colspan="9">No demand signals match the current filters.</td></tr>';
  byId('demandRows')
    .querySelectorAll('[data-inspect-signal]')
    .forEach((button) => {
      button.addEventListener('click', () => {
        changeState({ signal: button.dataset.inspectSignal, page: 1 }, { replace: false });
      });
    });
}

function renderCampaigns() {
  const state = stateFromUrl();
  byId('campaignRows').innerHTML = (DATA?.campaigns || []).length
    ? DATA.campaigns
        .map((campaign) => {
          const products = campaign.product_refs || [];
          const productCopy = products.length
            ? products
                .slice(0, 3)
                .map((product) => product.product || product.sku)
                .join(', ')
            : 'Product association unavailable';
          const highlighted = state.campaign === String(campaign.campaign_id || '');
          return `<tr data-campaign-id="${escapeHtml(campaign.campaign_id || '')}"${highlighted ? ' class="is-highlighted"' : ''}>
            <th scope="row"><strong>${escapeHtml(campaign.campaign_name || 'Unnamed campaign')}</strong><span>${escapeHtml(productCopy)}${products.length > 3 ? '…' : ''}</span><details class="ads-technical"><summary>Technical ID</summary><code>${escapeHtml(campaign.campaign_id || 'Unavailable')}</code></details></th>
            <td data-label="Spend" class="ads-num">${money(campaign.spend)}</td>
            <td data-label="Attributed sales" class="ads-num">${money(campaign.attributed_sales)}</td>
            <td data-label="ROAS / ACOS" class="ads-num">${multiple(campaign.roas)} / ${ratioPercent(campaign.acos)}</td>
            <td data-label="Traffic" class="ads-num">${integer(campaign.impressions)} imp. / ${integer(campaign.clicks)} clicks</td>
            <td data-label="Purchases / units" class="ads-num">${integer(campaign.purchases)} / ${integer(campaign.units)}</td>
            <td data-label="Demand"><button type="button" class="ads-row-action" data-campaign-demand="${escapeHtml(campaign.campaign_id || '')}">Review demand</button></td>
          </tr>`;
        })
        .join('')
    : '<tr><td colspan="7">No campaign data is available.</td></tr>';
  byId('campaignRows')
    .querySelectorAll('[data-campaign-demand]')
    .forEach((button) => {
      button.addEventListener('click', () => {
        changeState(
          { view: 'demand', campaign: button.dataset.campaignDemand, page: 1 },
          { clear: ['sku', 'signal', 'action', 'filter', 'sort', 'q', 'signalType'] },
        );
      });
    });
}

function fillSelect(select, rows, valueKey, labelKey, allLabel) {
  const current = select.value;
  select.innerHTML = `<option value="">${escapeHtml(allLabel)}</option>${rows
    .map(
      (row) =>
        `<option value="${escapeHtml(row[valueKey])}">${escapeHtml(row[labelKey] || row[valueKey])}</option>`,
    )
    .join('')}`;
  select.value = current;
}

function syncControls() {
  const state = stateFromUrl();
  byId('productSearch').value = state.view === 'products' ? state.q : '';
  byId('productFilter').value = state.view === 'products' ? state.filter || 'all' : 'all';
  byId('productSort').value = state.view === 'products' ? state.sort : 'decision';
  byId('demandSearch').value = state.view === 'demand' ? state.q : '';
  byId('demandFilter').value = state.view === 'demand' ? state.filter || 'all' : 'all';
  byId('demandType').value = state.view === 'demand' ? state.signalType || 'all' : 'all';
  byId('demandSort').value = state.view === 'demand' ? state.sort : 'decision';
  fillSelect(byId('demandSku'), DATA?.products || [], 'sku', 'product', 'All products');
  fillSelect(byId('demandCampaign'), DATA?.campaigns || [], 'campaign_id', 'campaign_name', 'All campaigns');
  byId('demandSku').value = state.sku;
  byId('demandCampaign').value = state.campaign;
}

function activateView(view, { focus = false } = {}) {
  const selected = VIEWS.has(view) ? view : 'impact';
  document.querySelectorAll('[data-ads-view]').forEach((button) => {
    const active = button.dataset.adsView === selected;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    if (active && focus) button.focus({ preventScroll: true });
  });
  document.querySelectorAll('.ads-view').forEach((panel) => {
    const active = panel.id === selected;
    panel.classList.toggle('active', active);
    panel.hidden = !active;
  });
}

function setViewAvailability(available, { preserveState = false } = {}) {
  const tabs = [...document.querySelectorAll('[data-ads-view]')];
  for (const tab of tabs) {
    const enabled = available || tab.dataset.adsView === 'impact';
    tab.disabled = !enabled;
    tab.setAttribute('aria-disabled', String(!enabled));
  }
  const state = stateFromUrl();
  if (!available && !preserveState && state.view !== 'impact') {
    state.view = 'impact';
    canonicalizeUrl(state);
  }
  activateView(available ? state.view : 'impact');
}

function focusDestination() {
  const state = stateFromUrl();
  let selector = '';
  if (state.view === 'products' && state.sku) selector = `#productRows [data-sku="${CSS.escape(state.sku)}"]`;
  if (state.view === 'demand' && state.signal) {
    selector = `#demandRows [data-signal-id="${CSS.escape(state.signal)}"]`;
  }
  if (state.view === 'detail' && state.campaign) {
    selector = `#campaignRows [data-campaign-id="${CSS.escape(state.campaign)}"]`;
  }
  const target = selector ? document.querySelector(selector) : null;
  if (!target) return;
  target.classList.add('is-highlighted');
  target.tabIndex = -1;
  requestAnimationFrame(() => {
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    target.focus({ preventScroll: true });
  });
}

function renderCharts() {
  if (!window.DPPCharts || !DATA) return;
  window.DPPCharts.ads('#chart', DATA.daily || []);
  window.DPPCharts.adsEfficiency('#campaignComparison', DATA.campaigns || []);
  if (window.DPPCharts.adsPortfolio) {
    window.DPPCharts.adsPortfolio('#portfolioChart', DATA.products || []);
  }
}

function renderReady(payload) {
  byId('readyState').hidden = false;
  byId('emptyState').hidden = true;
  byId('adsViewAvailability').hidden = true;
  setViewAvailability(true);
  const summary = payload.summary || {};
  const freshness = payload.freshness || {};
  byId('asof').textContent =
    `${payload.connection?.badge || 'Ads ready'} · through ${String(freshness.through_date || '').slice(5)}`;
  byId('workspaceRead').textContent =
    `Paid support across ${formatCount((payload.products || []).length, 'SKU')} · ${summary.period_start || 'start unavailable'} to ${summary.period_end || 'cutoff unavailable'}`;
  renderReadiness(payload);
  setMetric('spend', money(summary.spend));
  setMetric('spendDelta', deltaPercent(summary.spend_delta_pct));
  setMetric('attributed', money(summary.attributed_sales));
  setMetric('salesDelta', deltaPercent(summary.attributed_sales_delta_pct));
  setMetric('tacos', ratioPercent(summary.tacos));
  setMetric('tacosDelta', deltaPoints(summary.tacos_delta_points));
  setMetric('roas', multiple(summary.roas));
  setMetric('acos', ratioPercent(summary.acos));
  setMetric('ctr', ratioPercent(summary.ctr));
  setMetric('cpc', money(summary.cpc));
  setMetric('conversion', ratioPercent(summary.conversion_rate));
  setMetric('totalSales', money(summary.total_business_sales));
  byId('chartSub').textContent =
    `Daily spend and Amazon-attributed sales · ${summary.period_start || ''} → ${summary.period_end || ''}`;
  byId('basisCopy').textContent = summary.basis || 'Advertising metric basis unavailable.';
  byId('economicsCopy').textContent = payload.economics?.basis || 'Product economics are unavailable.';
  byId('economicsNotice').textContent = payload.economics?.basis || 'Product economics are unavailable.';
  renderActions(payload);
  renderPortfolio(payload.products || []);
  renderFunnel(summary);
  renderProducts();
  renderDemand();
  renderCampaigns();
  syncControls();
  renderCharts();
  activateView(stateFromUrl().view);
  focusDestination();
}

function renderUnavailable(payload) {
  byId('emptyState').hidden = false;
  byId('readyState').hidden = true;
  const connection = payload.connection || {};
  byId('emptyState').querySelector('h2').textContent =
    connection.headline || 'Amazon Ads state is unavailable.';
  const progress = connection.report_progress;
  const sequence =
    progress?.report_number && progress?.report_total
      ? ` (${progress.report_number}/${progress.report_total})`
      : '';
  const progressDetail = progress?.report_id
    ? ` Current API report: ${String(progress.grain || 'report').replace('_', ' ')}${sequence} · ${progress.vendor_status || 'UNKNOWN'} · ${Math.max(0, Math.floor(Number(progress.elapsed_seconds || 0) / 60))}m elapsed.`
    : '';
  byId('emptyState').querySelector('p').textContent =
    `${connection.detail || 'The current Amazon Ads connection state could not be read.'}${progressDetail}`;
  byId('adsViewAvailability').hidden = false;
  byId('adsViewAvailability').textContent =
    'Only Business impact is available in the current Advertising connection state.';
  byId('asof').textContent = connection.badge || 'Ads state unavailable';
  byId('readinessLabel').textContent = connection.badge || 'Ads unavailable';
  byId('readinessLine').textContent = connection.detail || 'Reporting state unavailable';
  setViewAvailability(false);
}

function applyViewState() {
  const state = stateFromUrl();
  canonicalizeUrl(state);
  activateView(state.view);
  if (DATA?.status === 'ready') {
    renderProducts();
    renderDemand();
    renderCampaigns();
    syncControls();
    focusDestination();
  }
}

async function loadData() {
  const sequence = ++requestSequence;
  try {
    const payload = await fetchJson(queryForApi(), { forceRefresh: true });
    if (sequence !== requestSequence) return;
    DATA = payload;
    byId('clock').textContent = formatBusinessClock(payload.local_time);
    if (payload.connection?.state === 'READY' && payload.status === 'ready') {
      await loadAdsChartDependencies();
      if (sequence !== requestSequence) return;
      renderReady(payload);
    } else renderUnavailable(payload);
  } catch (error) {
    if (sequence !== requestSequence) return;
    byId('emptyState').hidden = false;
    byId('readyState').hidden = true;
    byId('emptyState').querySelector('h2').textContent = 'Advertising data is temporarily unavailable.';
    byId('emptyState').querySelector('p').textContent = error.message;
    byId('asof').textContent = 'Ads unavailable';
    byId('readinessLabel').textContent = 'Ads unavailable';
    byId('readinessLine').textContent = 'Reporting could not be reached';
    byId('adsViewAvailability').hidden = false;
    byId('adsViewAvailability').textContent =
      'Only Business impact is available while Advertising reporting cannot be reached.';
    setViewAvailability(false);
  }
}

function changeView(view) {
  changeState(
    { view, page: 1 },
    { clear: STATE_KEYS.filter((key) => key !== 'page'), load: view === 'demand' },
  );
  if (view !== 'demand') {
    renderProducts();
    renderCampaigns();
    syncControls();
    activateView(view, { focus: true });
    renderCharts();
  }
}

function bindInteractions() {
  const viewTabs = [...document.querySelectorAll('[data-ads-view]')];
  viewTabs.forEach((button) => {
    button.addEventListener('click', () => {
      if (!button.disabled) changeView(button.dataset.adsView);
    });
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const enabledTabs = viewTabs.filter((tab) => !tab.disabled);
      const current = enabledTabs.indexOf(button);
      let next = current;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = enabledTabs.length - 1;
      if (event.key === 'ArrowLeft') next = (current - 1 + enabledTabs.length) % enabledTabs.length;
      if (event.key === 'ArrowRight') next = (current + 1) % enabledTabs.length;
      event.preventDefault();
      changeView(enabledTabs[next].dataset.adsView);
    });
  });
  byId('openProducts').addEventListener('click', () => changeView('products'));
  byId('productFilter').addEventListener('change', (event) => {
    changeState(
      { filter: event.target.value === 'all' ? '' : event.target.value, page: 1 },
      { replace: false, load: false },
    );
    renderProducts();
    syncControls();
  });
  byId('productSort').addEventListener('change', (event) => {
    changeState({ sort: event.target.value }, { replace: false, load: false });
    renderProducts();
  });
  byId('productSearch').addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      changeState({ q: event.target.value.trim(), page: 1 }, { replace: true, load: false });
      renderProducts();
    }, 180);
  });
  for (const [id, key] of [
    ['demandFilter', 'filter'],
    ['demandType', 'signalType'],
    ['demandSku', 'sku'],
    ['demandCampaign', 'campaign'],
    ['demandSort', 'sort'],
  ]) {
    byId(id).addEventListener('change', (event) => {
      const value = event.target.value === 'all' ? '' : event.target.value;
      changeState({ [key]: value, signal: '', action: '', page: 1 });
    });
  }
  byId('demandSearch').addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      changeState({ q: event.target.value.trim(), signal: '', action: '', page: 1 }, { replace: true });
    }, 220);
  });
  byId('demandPrev').addEventListener('click', () => {
    changeState({ page: Math.max(1, stateFromUrl().page - 1) });
  });
  byId('demandNext').addEventListener('click', () => {
    changeState({ page: stateFromUrl().page + 1 });
  });
  window.addEventListener('popstate', () => loadData());
}

async function start() {
  bindInteractions();
  const state = stateFromUrl();
  canonicalizeUrl(state);
  activateView(state.view);
  setViewAvailability(false, { preserveState: true });
  byId('clock').textContent = formatBusinessClock();
  await loadData();
}

start();
