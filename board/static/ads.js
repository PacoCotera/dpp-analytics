import { byId, escapeHtml, fetchJson, integer, money } from './ui-utils.js';

let operatingTrusted = false;

function ratioPercent(value) {
  return value === null || value === undefined ? '—' : `${(Number(value) * 100).toFixed(1)}%`;
}

function deltaPercent(value) {
  if (value === null || value === undefined) return '—';
  const numeric = Number(value);
  return `${numeric > 0 ? '+' : ''}${numeric.toFixed(1)}%`;
}

function deltaPoints(value) {
  if (value === null || value === undefined) return '—';
  const numeric = Number(value);
  return `${numeric > 0 ? '+' : ''}${numeric.toFixed(1)} pts`;
}

function multiple(value) {
  return value === null || value === undefined ? '—' : `${Number(value).toFixed(2)}×`;
}

function setMetric(id, value, tone = '') {
  const element = byId(id);
  if (!element) return;
  element.textContent = value;
  element.classList.remove('good', 'bad', 'warn');
  if (tone) element.classList.add(tone);
}

function inverseTone(value) {
  if (value === null || value === undefined) return '';
  const numeric = Number(value);
  if (numeric < 0) return 'good';
  if (numeric > 0) return 'bad';
  return '';
}

function normalTone(value) {
  if (value === null || value === undefined) return '';
  const numeric = Number(value);
  if (numeric > 0) return 'good';
  if (numeric < 0) return 'bad';
  return '';
}

function renderStory(summary) {
  const spend = Number(summary.spend_delta_pct || 0);
  const acos = summary.acos_delta_points;
  const tacos = summary.tacos_delta_points;
  let title = 'Paid support is stable.';
  let copy = 'Spend is close to the prior 28-day window.';

  if (spend >= 10) {
    title = 'We are leaning harder on advertising.';
    copy = `Ad spend is ${deltaPercent(spend)} versus the prior 28 days.`;
  } else if (spend <= -10) {
    title = 'Paid support has eased.';
    copy = `Ad spend is ${deltaPercent(spend)} versus the prior 28 days.`;
  }

  if (tacos != null) {
    if (Number(tacos) <= -1) {
      copy += ` TACOS improved by ${Math.abs(Number(tacos)).toFixed(1)} points, so ads are consuming less of total sales.`;
    } else if (Number(tacos) >= 1) {
      copy += ` TACOS worsened by ${Number(tacos).toFixed(1)} points, so ads are consuming more of total sales.`;
    } else {
      copy += ' TACOS is broadly stable.';
    }
  }

  if (acos != null && Math.abs(Number(acos)) >= 2) {
    copy += Number(acos) < 0 ? ' ACOS also improved.' : ' ACOS also deteriorated.';
  }

  if (!operatingTrusted) {
    title = 'Paid demand is visible, but not decision-grade yet.';
    copy = 'Amazon Ads metrics are shown for observability while report-grain reconciliation or period coverage is incomplete. Review the data-quality state before acting on efficiency changes.';
  }

  byId('storyTitle').textContent = title;
  byId('storyCopy').textContent = copy;
}

function issueLabel(state) {
  return ({
    ACCOUNT_MARKETPLACE_MISSING: 'account marketplace mapping',
    CURRENCY_MISMATCH: 'currency mismatch',
    CAMPAIGN_GRAIN_MISSING: 'campaign report missing',
    PRODUCT_GRAIN_MISSING: 'advertised-product report missing',
    ACCOUNT_ROLLUP_INCONSISTENT: 'account rollup inconsistency',
    INDEPENDENT_REPORT_VALUE_MISMATCH: 'campaign/product value mismatch',
    ATTRIBUTION_CONTRACT_MISMATCH: 'attribution contract mismatch',
    SELLER_SALES_DENOMINATOR_MISSING: 'seller-sales denominator missing',
  })[state] || String(state || '').toLowerCase().replaceAll('_', ' ');
}

function renderQuality(payload) {
  const quality = payload.quality || {};
  const freshness = payload.freshness || {};
  operatingTrusted = Boolean(quality.trusted_for_operating_decisions);

  const badge = byId('qualityBadge');
  const title = byId('qualityTitle');
  const copy = byId('qualityCopy');
  const band = byId('qualityBand');
  badge.classList.remove('trusted', 'attention', 'nodata');
  band.classList.remove('trusted', 'attention', 'nodata');

  if (operatingTrusted) {
    badge.textContent = 'Decision-grade';
    badge.classList.add('trusted');
    band.classList.add('trusted');
    title.textContent = 'Independent Amazon report grains reconcile.';
    copy.textContent = 'Campaign and advertised-product commercial values agree, attribution semantics are consistent, seller-sales coverage is present, and the 28-day reporting window is complete.';
  } else if (quality.state === 'ATTENTION') {
    badge.textContent = 'Verify data';
    badge.classList.add('attention');
    band.classList.add('attention');
    title.textContent = 'Use Ads metrics as evidence, not as an action trigger.';
    const issues = (quality.issues || []).slice(0, 3).map(item => `${issueLabel(item.quality_state)} (${integer(item.days)}d)`).join(', ');
    copy.textContent = issues
      ? `Quality issues in the current operating window: ${issues}. Drilldowns remain visible, but action cues are suppressed until reconciliation is healthy.`
      : 'The current Ads period has reconciliation or coverage issues. Drilldowns remain visible, but action cues are suppressed until reconciliation is healthy.';
  } else {
    badge.textContent = 'Not validated';
    badge.classList.add('nodata');
    band.classList.add('nodata');
    title.textContent = 'Waiting for enough Ads reporting to validate the operating window.';
    copy.textContent = 'Metrics can appear before all independent reporting grains are available. The product will not call them decision-grade until reconciliation passes.';
  }

  const observed = Number(freshness.period_observed_days || 0);
  const expected = Number(freshness.period_expected_days || 28);
  const mature = Number(freshness.mature_days || 0);
  byId('coverageRead').textContent = `${observed}/${expected} days`;
  byId('maturityRead').textContent = `${mature}/${observed || expected} days`;
  byId('qualityIssueRead').textContent = quality.issue_days ? `${integer(quality.issue_days)} days` : quality.state === 'HEALTHY' ? 'none' : '—';
}

function renderCampaigns(rows = []) {
  byId('campaignRows').innerHTML = rows.length
    ? rows.map(row => `<tr>
        <td class="product-cell"><strong>${escapeHtml(row.campaign_name || row.campaign_id)}</strong><div class="ads-subtle">${escapeHtml(row.ad_product || '')}</div></td>
        <td data-label="Spend" class="ads-num">${money(row.spend)}</td>
        <td data-label="Attributed" class="ads-num">${money(row.attributed_sales)}</td>
        <td data-label="ACOS" class="ads-num ads-efficiency">${ratioPercent(row.acos)}</td>
        <td data-label="Clicks" class="ads-num">${integer(row.clicks)}</td>
      </tr>`).join('')
    : '<tr><td>No campaign data yet.</td></tr>';
}

function renderProducts(rows = []) {
  byId('productRows').innerHTML = rows.length
    ? rows.map(row => {
        const image = row.image_url
          ? `<span class="product-thumb-well"><img class="product-thumb" src="${escapeHtml(row.image_url)}" alt="" loading="lazy"></span>`
          : '';
        const body = `${image}<div><strong>${escapeHtml(row.product || row.sku || row.asin || 'Unknown product')}</strong><div class="ads-subtle">${escapeHtml(row.sku || row.asin || '')}</div></div>`;
        return `<tr>
          <td class="product-cell">${row.sku ? `<a class="product-line" href="/product?sku=${encodeURIComponent(row.sku)}">${body}</a>` : `<div class="product-line">${body}</div>`}</td>
          <td data-label="Spend" class="ads-num">${money(row.spend)}</td>
          <td data-label="Attributed" class="ads-num">${money(row.attributed_sales)}</td>
          <td data-label="ACOS" class="ads-num ads-efficiency">${ratioPercent(row.acos)}</td>
          <td data-label="Clicks" class="ads-num">${integer(row.clicks)}</td>
        </tr>`;
      }).join('')
    : '<tr><td>No advertised-product data yet.</td></tr>';
}

function signal(row) {
  if (Number(row.purchases || 0) > 0) return '<span class="ads-signal converting">Attributed purchase</span>';
  if (Number(row.spend || 0) > 0) return '<span class="ads-signal spend">Spend, no attributed purchase</span>';
  return '<span class="ads-signal">No spend</span>';
}

function action(row, kind) {
  if (!operatingTrusted) {
    return '<span class="ads-action verify" title="Operating cues are disabled until independent Ads report grains reconcile and period coverage is complete.">Verify data</span>';
  }
  const purchases = Number(row.purchases || 0);
  const clicks = Number(row.clicks || 0);
  const spend = Number(row.spend || 0);
  const roas = Number(row.roas || 0);

  if (kind === 'search' && purchases >= 2 && roas >= 2) {
    return '<span class="ads-action harvest" title="Repeated attributed purchases with at least 2× ROAS. Review for a dedicated target; do not auto-change bids.">Harvest candidate</span>';
  }
  if (spend > 0 && purchases === 0 && clicks >= 8) {
    return '<span class="ads-action inspect" title="Material click learning without an attributed purchase. Inspect relevance and economics before changing targeting.">Inspect spend</span>';
  }
  return '<span class="ads-action learn" title="Not enough evidence for a stronger operating cue yet.">Learning</span>';
}

function renderTargets(rows = []) {
  byId('targetRows').innerHTML = rows.length
    ? rows.map(row => {
        const name = row.target_expression || row.target_id || 'Unnamed target';
        const context = [row.target_type, row.match_type].filter(Boolean).join(' · ');
        return `<tr>
          <td class="product-cell"><div class="ads-query">${escapeHtml(name)}</div><div class="ads-context">${escapeHtml(context)}</div>${signal(row)}</td>
          <td data-label="Campaign"><strong>${escapeHtml(row.campaign_name || row.campaign_id || '—')}</strong></td>
          <td data-label="Action">${action(row, 'target')}</td>
          <td data-label="Spend" class="ads-num">${money(row.spend)}</td>
          <td data-label="Attributed" class="ads-num">${money(row.attributed_sales)}</td>
          <td data-label="ACOS" class="ads-num ads-efficiency">${ratioPercent(row.acos)}</td>
          <td data-label="ROAS" class="ads-num ads-efficiency">${multiple(row.roas)}</td>
          <td data-label="Clicks" class="ads-num">${integer(row.clicks)}</td>
        </tr>`;
      }).join('')
    : '<tr><td class="ads-empty-drill">No target-grain rows yet. The workspace will populate after Amazon Ads reporting is authorized and backfilled.</td></tr>';
}

function renderSearchTerms(rows = []) {
  byId('searchTermRows').innerHTML = rows.length
    ? rows.map(row => {
        const context = [row.match_type, row.target_id ? `target ${row.target_id}` : ''].filter(Boolean).join(' · ');
        return `<tr>
          <td class="product-cell"><div class="ads-query">${escapeHtml(row.search_term || 'Unspecified query')}</div><div class="ads-context">${escapeHtml(context)}</div>${signal(row)}</td>
          <td data-label="Campaign"><strong>${escapeHtml(row.campaign_name || row.campaign_id || '—')}</strong></td>
          <td data-label="Action">${action(row, 'search')}</td>
          <td data-label="Spend" class="ads-num">${money(row.spend)}</td>
          <td data-label="Attributed" class="ads-num">${money(row.attributed_sales)}</td>
          <td data-label="ACOS" class="ads-num ads-efficiency">${ratioPercent(row.acos)}</td>
          <td data-label="ROAS" class="ads-num ads-efficiency">${multiple(row.roas)}</td>
          <td data-label="Clicks" class="ads-num">${integer(row.clicks)}</td>
        </tr>`;
      }).join('')
    : '<tr><td class="ads-empty-drill">No shopper-query rows yet. Search-term reporting will populate after Amazon Ads authorization and backfill.</td></tr>';
}

function activateView(button) {
  document.querySelectorAll('[data-ads-view]').forEach(item => {
    const active = item === button;
    item.classList.toggle('active', active);
    item.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.ads-view').forEach(view => {
    view.classList.toggle('active', view.id === button.dataset.adsView);
  });
}

function renderReady(payload) {
  byId('readyState').hidden = false;
  byId('emptyState').hidden = true;

  const summary = payload.summary || {};
  const freshness = payload.freshness || {};
  byId('asof').textContent = `Ads through ${String(freshness.through_date || '').slice(5)}`;

  renderQuality(payload);
  setMetric('spend', money(summary.spend));
  setMetric('spendDelta', deltaPercent(summary.spend_delta_pct), normalTone(summary.spend_delta_pct));
  setMetric('attributed', money(summary.attributed_sales));
  setMetric('salesDelta', deltaPercent(summary.attributed_sales_delta_pct), normalTone(summary.attributed_sales_delta_pct));
  setMetric('acos', ratioPercent(summary.acos));
  setMetric('acosDelta', deltaPoints(summary.acos_delta_points), inverseTone(summary.acos_delta_points));
  setMetric('tacos', ratioPercent(summary.tacos));
  setMetric('tacosDelta', deltaPoints(summary.tacos_delta_points), inverseTone(summary.tacos_delta_points));
  setMetric('roas', multiple(summary.roas));
  setMetric('ctr', ratioPercent(summary.ctr));
  setMetric('cpc', money(summary.cpc));
  setMetric('totalSales', money(summary.total_business_sales));

  byId('chartSub').textContent = `Daily spend and attributed sales · ${summary.period_start || ''} → ${summary.period_end || ''}`;
  renderStory(summary);
  if (window.DPPCharts) {
    window.DPPCharts.ads('#chart', payload.daily || []);
    window.DPPCharts.adsEfficiency('#campaignQuadrant', payload.campaigns || []);
  }
  renderCampaigns(payload.campaigns);
  renderProducts(payload.products);
  renderTargets(payload.targets);
  renderSearchTerms(payload.search_terms);
}

function renderUnavailable(payload) {
  operatingTrusted = false;
  byId('emptyState').hidden = false;
  byId('readyState').hidden = true;
  byId('asof').textContent = payload.status === 'awaiting_ads_data' ? 'Awaiting Ads data' : 'Ads not initialized';
  renderTargets([]);
  renderSearchTerms([]);
}

function bindInteractions() {
  document.querySelectorAll('[data-ads-view]').forEach(button => {
    button.addEventListener('click', () => activateView(button));
  });
}

async function start() {
  bindInteractions();
  byId('clock').textContent = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date());

  try {
    const payload = await fetchJson('/api/ads');
    if (payload.local_time) byId('clock').textContent = payload.local_time;
    if (payload.status === 'ready') renderReady(payload);
    else renderUnavailable(payload);
  } catch (error) {
    operatingTrusted = false;
    byId('emptyState').hidden = false;
    byId('emptyState').querySelector('h2').textContent = 'Advertising data is temporarily unavailable.';
    byId('emptyState').querySelector('p').textContent = error.message;
    byId('asof').textContent = 'Ads unavailable';
  }
}

start();
