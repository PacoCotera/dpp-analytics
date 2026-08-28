import { byId, escapeHtml, fetchJson, formatBusinessClock, formatCount, integer, money } from './ui-utils.js';
let operatingTrusted = false;
const ratioPercent = (v) => (v == null ? '—' : `${(Number(v) * 100).toFixed(1)}%`);
const deltaPercent = (v) => (v == null ? '—' : `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(1)}%`);
const deltaPoints = (v) => (v == null ? '—' : `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(1)} pts`);
const multiple = (v) => (v == null ? '—' : `${Number(v).toFixed(2)}×`);
function setMetric(id, value, tone = '') {
  const e = byId(id);
  if (!e) return;
  e.textContent = value;
  e.classList.remove('good', 'bad', 'warn');
  if (tone) e.classList.add(tone);
}
const inverseTone = (v) => (v == null ? '' : Number(v) < 0 ? 'good' : Number(v) > 0 ? 'bad' : '');
const normalTone = (v) => (v == null ? '' : Number(v) > 0 ? 'good' : Number(v) < 0 ? 'bad' : '');
function renderStory(s) {
  const spend = Number(s.spend_delta_pct || 0),
    acos = s.acos_delta_points,
    tacos = s.tacos_delta_points;
  let title = 'Paid support is stable.',
    copy = 'Spend is close to the prior 28-day window.';
  if (spend >= 10) {
    title = 'We are leaning harder on advertising.';
    copy = `Ad spend is ${deltaPercent(spend)} versus the prior 28 days.`;
  } else if (spend <= -10) {
    title = 'Paid support has eased.';
    copy = `Ad spend is ${deltaPercent(spend)} versus the prior 28 days.`;
  }
  if (tacos != null)
    copy +=
      Number(tacos) <= -1
        ? ` TACOS improved by ${Math.abs(Number(tacos)).toFixed(1)} points, so ads are consuming less of total sales.`
        : Number(tacos) >= 1
          ? ` TACOS worsened by ${Number(tacos).toFixed(1)} points, so ads are consuming more of total sales.`
          : ' TACOS is broadly stable.';
  if (acos != null && Math.abs(Number(acos)) >= 2)
    copy += Number(acos) < 0 ? ' ACOS also improved.' : ' ACOS also deteriorated.';
  if (!operatingTrusted) {
    title = 'Paid demand is visible, but not decision-grade yet.';
    copy =
      'Amazon Ads metrics are shown for observability while report-grain reconciliation or period coverage is incomplete. Review the data-quality state before acting on efficiency changes.';
  }
  byId('storyTitle').textContent = title;
  byId('storyCopy').textContent = copy;
}
function issueLabel(s) {
  return (
    {
      ACCOUNT_MARKETPLACE_MISSING: 'account marketplace mapping',
      CURRENCY_MISMATCH: 'currency mismatch',
      CAMPAIGN_GRAIN_MISSING: 'campaign report missing',
      PRODUCT_GRAIN_MISSING: 'advertised-product report missing',
      ACCOUNT_ROLLUP_INCONSISTENT: 'account rollup inconsistency',
      INDEPENDENT_REPORT_VALUE_MISMATCH: 'campaign/product value mismatch',
      ATTRIBUTION_CONTRACT_MISMATCH: 'attribution contract mismatch',
      SELLER_SALES_DENOMINATOR_MISSING: 'seller-sales denominator missing',
    }[s] ||
    String(s || '')
      .toLowerCase()
      .replaceAll('_', ' ')
  );
}
function renderQuality(p) {
  const q = p.quality || {},
    f = p.freshness || {};
  operatingTrusted = Boolean(q.trusted_for_operating_decisions);
  const badge = byId('qualityBadge'),
    title = byId('qualityTitle'),
    copy = byId('qualityCopy'),
    band = byId('qualityBand');
  badge.classList.remove('trusted', 'attention', 'nodata');
  band.classList.remove('trusted', 'attention', 'nodata');
  if (operatingTrusted) {
    badge.textContent = 'Decision-grade';
    badge.classList.add('trusted');
    band.classList.add('trusted');
    title.textContent = 'Independent Amazon report grains reconcile.';
    copy.textContent =
      'Campaign and advertised-product commercial values agree, attribution semantics are consistent, seller-sales coverage is present, and the 28-day reporting window is complete.';
  } else if (q.state === 'ATTENTION') {
    badge.textContent = 'Verify data';
    badge.classList.add('attention');
    band.classList.add('attention');
    title.textContent = 'Use Ads metrics as evidence, not as an action trigger.';
    const issues = (q.issues || [])
      .slice(0, 3)
      .map((i) => `${issueLabel(i.quality_state)} (${integer(i.days)}d)`)
      .join(', ');
    copy.textContent = issues
      ? `Quality issues in the current operating window: ${issues}. Action cues are suppressed until reconciliation is healthy.`
      : 'The current Ads period has reconciliation or coverage issues. Action cues are suppressed until reconciliation is healthy.';
  } else {
    badge.textContent = 'Not validated';
    badge.classList.add('nodata');
    band.classList.add('nodata');
    title.textContent = 'Waiting for enough Ads reporting to validate the operating window.';
    copy.textContent =
      'Metrics can appear before all independent reporting grains are available. The product will not call them decision-grade until reconciliation passes.';
  }
  const observed = Number(f.period_observed_days || 0),
    expected = Number(f.period_expected_days || 28),
    mature = Number(f.mature_days || 0);
  byId('coverageRead').textContent = `${observed}/${formatCount(expected, 'day')}`;
  byId('maturityRead').textContent = `${mature}/${formatCount(observed || expected, 'day')}`;
  byId('qualityIssueRead').textContent = q.issue_days
    ? formatCount(q.issue_days, 'day')
    : q.state === 'HEALTHY'
      ? 'none'
      : '—';
}
function renderActions(rows = []) {
  const section = byId('actionSection'),
    host = byId('actionQueue');
  if (!operatingTrusted || !rows.length) {
    section.hidden = true;
    host.innerHTML = '';
    return;
  }
  section.hidden = false;
  byId('actionCount').textContent = String(rows.length);
  host.innerHTML = rows
    .map((r, i) => {
      const productHref = r.sku ? `/product?sku=${encodeURIComponent(r.sku)}` : null;
      const view =
        r.kind === 'HARVEST_SEARCH_TERM'
          ? 'searchTerms'
          : r.kind === 'INSPECT_TARGET_SPEND'
            ? 'targets'
            : 'products';
      const title = escapeHtml(r.title || 'Review item'),
        context = escapeHtml(r.context || '');
      return `<article class="ads-action-card"><div class="ads-action-rank">${i + 1}</div><div class="ads-action-body"><div class="ads-action-head"><span class="ads-action ${r.priority === 1 ? 'harvest' : r.priority === 2 ? 'inspect' : 'learn'}">${escapeHtml(r.label || 'Review')}</span><strong>${productHref ? `<a href="${productHref}">${title}</a>` : title}</strong></div><div class="ads-context">${context}</div><p>${escapeHtml(r.reason || '')}</p><div class="ads-action-metrics"><span><b>${money(r.spend)}</b> spend</span><span><b>${multiple(r.roas)}</b> ROAS</span>${r.tacos != null ? `<span><b>${ratioPercent(r.tacos)}</b> TACOS</span>` : ''}</div></div><button class="ads-action-open" type="button" data-open-ads-view="${view}">Inspect</button></article>`;
    })
    .join('');
  host.querySelectorAll('[data-open-ads-view]').forEach((b) =>
    b.addEventListener('click', () => {
      const tab = document.querySelector(`[data-ads-view="${b.dataset.openAdsView}"]`);
      if (tab) {
        activateView(tab);
        tab.scrollIntoView({ block: 'nearest' });
      }
    }),
  );
}
function renderCampaigns(rows = []) {
  byId('campaignRows').innerHTML = rows.length
    ? rows
        .map(
          (r) =>
            `<tr><td class="product-cell"><strong>${escapeHtml(r.campaign_name || r.campaign_id)}</strong><div class="ads-subtle">${escapeHtml(r.ad_product || '')}</div></td><td data-label="Spend" class="ads-num">${money(r.spend)}</td><td data-label="Attributed" class="ads-num">${money(r.attributed_sales)}</td><td data-label="ACOS" class="ads-num ads-efficiency">${ratioPercent(r.acos)}</td><td data-label="Clicks" class="ads-num">${integer(r.clicks)}</td></tr>`,
        )
        .join('')
    : '<tr><td>No campaign data yet.</td></tr>';
}
function renderProducts(rows = []) {
  byId('productRows').innerHTML = rows.length
    ? rows
        .map((r) => {
          const image = r.image_url
            ? `<span class="product-thumb-well"><img class="product-thumb" src="${escapeHtml(r.image_url)}" alt="" loading="lazy"></span>`
            : '';
          const body = `${image}<div><strong>${escapeHtml(r.product || r.sku || r.asin || 'Unknown product')}</strong><div class="ads-subtle">${escapeHtml(r.sku || r.asin || '')}</div></div>`;
          return `<tr><td class="product-cell">${r.sku ? `<a class="product-line" href="/product?sku=${encodeURIComponent(r.sku)}">${body}</a>` : `<div class="product-line">${body}</div>`}</td><td data-label="Spend" class="ads-num">${money(r.spend)}</td><td data-label="Attributed" class="ads-num">${money(r.attributed_sales)}</td><td data-label="ACOS" class="ads-num">${ratioPercent(r.acos)}</td><td data-label="Clicks" class="ads-num">${integer(r.clicks)}</td></tr>`;
        })
        .join('')
    : '<tr><td>No advertised-product data yet.</td></tr>';
}
function signal(r) {
  if (Number(r.purchases || 0) > 0) return '<span class="ads-signal converting">Attributed purchase</span>';
  if (Number(r.spend || 0) > 0) return '<span class="ads-signal spend">Spend, no attributed purchase</span>';
  return '<span class="ads-signal">No spend</span>';
}
function action(r, kind) {
  if (!operatingTrusted) return '<span class="ads-action verify">Verify data</span>';
  const p = Number(r.purchases || 0),
    c = Number(r.clicks || 0),
    s = Number(r.spend || 0),
    roas = Number(r.roas || 0);
  if (kind === 'search' && p >= 2 && roas >= 2)
    return '<span class="ads-action harvest">Harvest candidate</span>';
  if (s > 0 && p === 0 && c >= 8) return '<span class="ads-action inspect">Inspect spend</span>';
  return '<span class="ads-action learn">Learning</span>';
}
function renderTargets(rows = []) {
  byId('targetRows').innerHTML = rows.length
    ? rows
        .map(
          (r) =>
            `<tr><td class="product-cell"><div class="ads-query">${escapeHtml(r.target_expression || r.target_id || 'Unnamed target')}</div><div class="ads-context">${escapeHtml([r.target_type, r.match_type].filter(Boolean).join(' · '))}</div>${signal(r)}</td><td data-label="Campaign"><strong>${escapeHtml(r.campaign_name || r.campaign_id || '—')}</strong></td><td data-label="Action">${action(r, 'target')}</td><td data-label="Spend" class="ads-num">${money(r.spend)}</td><td data-label="Attributed" class="ads-num">${money(r.attributed_sales)}</td><td data-label="ACOS" class="ads-num">${ratioPercent(r.acos)}</td><td data-label="ROAS" class="ads-num">${multiple(r.roas)}</td><td data-label="Clicks" class="ads-num">${integer(r.clicks)}</td></tr>`,
        )
        .join('')
    : '<tr><td class="ads-empty-drill">No target-grain rows yet.</td></tr>';
}
function renderSearchTerms(rows = []) {
  byId('searchTermRows').innerHTML = rows.length
    ? rows
        .map(
          (r) =>
            `<tr><td class="product-cell"><div class="ads-query">${escapeHtml(r.search_term || 'Unspecified query')}</div><div class="ads-context">${escapeHtml([r.match_type, r.target_id ? `target ${r.target_id}` : ''].filter(Boolean).join(' · '))}</div>${signal(r)}</td><td data-label="Campaign"><strong>${escapeHtml(r.campaign_name || r.campaign_id || '—')}</strong></td><td data-label="Action">${action(r, 'search')}</td><td data-label="Spend" class="ads-num">${money(r.spend)}</td><td data-label="Attributed" class="ads-num">${money(r.attributed_sales)}</td><td data-label="ACOS" class="ads-num">${ratioPercent(r.acos)}</td><td data-label="ROAS" class="ads-num">${multiple(r.roas)}</td><td data-label="Clicks" class="ads-num">${integer(r.clicks)}</td></tr>`,
        )
        .join('')
    : '<tr><td class="ads-empty-drill">No shopper-query rows yet.</td></tr>';
}
function activateView(button) {
  document.querySelectorAll('[data-ads-view]').forEach((i) => {
    const a = i === button;
    i.classList.toggle('active', a);
    i.setAttribute('aria-selected', String(a));
  });
  document
    .querySelectorAll('.ads-view')
    .forEach((v) => v.classList.toggle('active', v.id === button.dataset.adsView));
}
function renderReady(p) {
  byId('readyState').hidden = false;
  byId('emptyState').hidden = true;
  const s = p.summary || {},
    f = p.freshness || {};
  byId('asof').textContent =
    `${p.connection?.badge || 'Ads ready'} · through ${String(f.through_date || '').slice(5)}`;
  renderQuality(p);
  setMetric('spend', money(s.spend));
  setMetric('spendDelta', deltaPercent(s.spend_delta_pct), normalTone(s.spend_delta_pct));
  setMetric('attributed', money(s.attributed_sales));
  setMetric(
    'salesDelta',
    deltaPercent(s.attributed_sales_delta_pct),
    normalTone(s.attributed_sales_delta_pct),
  );
  setMetric('acos', ratioPercent(s.acos));
  setMetric('acosDelta', deltaPoints(s.acos_delta_points), inverseTone(s.acos_delta_points));
  setMetric('tacos', ratioPercent(s.tacos));
  setMetric('tacosDelta', deltaPoints(s.tacos_delta_points), inverseTone(s.tacos_delta_points));
  setMetric('roas', multiple(s.roas));
  setMetric('ctr', ratioPercent(s.ctr));
  setMetric('cpc', money(s.cpc));
  setMetric('totalSales', money(s.total_business_sales));
  byId('chartSub').textContent =
    `Daily spend and attributed sales · ${s.period_start || ''} → ${s.period_end || ''}`;
  renderStory(s);
  renderActions(p.actions || []);
  if (window.DPPCharts) {
    window.DPPCharts.ads('#chart', p.daily || []);
    window.DPPCharts.adsEfficiency('#campaignQuadrant', p.campaigns || []);
  }
  renderCampaigns(p.campaigns);
  renderProducts(p.products);
  renderTargets(p.targets);
  renderSearchTerms(p.search_terms);
}
function renderUnavailable(p) {
  operatingTrusted = false;
  byId('emptyState').hidden = false;
  byId('readyState').hidden = true;
  const connection = p.connection || {};
  byId('emptyState').querySelector('h2').textContent =
    connection.headline || 'Amazon Ads state is unavailable.';
  byId('emptyState').querySelector('p').textContent =
    connection.detail || 'The current Amazon Ads connection state could not be read.';
  byId('asof').textContent = connection.badge || 'Ads state unavailable';
  renderTargets([]);
  renderSearchTerms([]);
}
function bindInteractions() {
  document
    .querySelectorAll('[data-ads-view]')
    .forEach((b) => b.addEventListener('click', () => activateView(b)));
}
async function start() {
  bindInteractions();
  byId('clock').textContent = formatBusinessClock();
  try {
    const p = await fetchJson('/api/ads');
    byId('clock').textContent = formatBusinessClock(p.local_time);
    if (p.connection?.state === 'READY' && p.status === 'ready') renderReady(p);
    else renderUnavailable(p);
  } catch (e) {
    operatingTrusted = false;
    byId('emptyState').hidden = false;
    byId('emptyState').querySelector('h2').textContent = 'Advertising data is temporarily unavailable.';
    byId('emptyState').querySelector('p').textContent = e.message;
    byId('asof').textContent = 'Ads unavailable';
  }
}
start();
