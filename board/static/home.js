import {
  escapeHtml,
  fetchJson,
  formatBusinessClock,
  formatCount,
  formatMonthYear,
  formatMetricWindow,
  integer,
  money,
  mountRuleTrigger,
  percent,
  tone,
} from './ui-utils.js';

function renderAds(ads) {
  const a = ads || {},
    panel = document.getElementById('adsRead'),
    metrics = document.getElementById('adsMetrics'),
    headline = document.getElementById('adsHeadline'),
    note = document.getElementById('adsNote');
  if (!a.through_date) {
    panel.hidden = true;
    metrics.hidden = true;
    headline.textContent = 'Waiting for Amazon Ads access';
    note.textContent =
      a.note || 'Sales interpretation remains independent until advertising data is available.';
    return;
  }
  panel.hidden = false;
  metrics.hidden = false;
  document.getElementById('adsSpend').textContent = money(a.spend);
  document.getElementById('adsRoas').textContent = a.roas == null ? '—' : `${Number(a.roas).toFixed(2)}×`;
  document.getElementById('adsAcos').textContent = a.acos == null ? '—' : `${Number(a.acos).toFixed(1)}%`;
  document.getElementById('adsTacos').textContent = a.tacos == null ? '—' : `${Number(a.tacos).toFixed(1)}%`;
  headline.textContent = a.trusted
    ? 'Advertising context is decision-grade'
    : 'Advertising context is still provisional';
  const coverage = `${integer(a.observed_days)} of ${integer(a.expected_days)} days observed`;
  note.textContent = `${coverage} · through ${String(a.through_date).slice(0, 10)}. Amazon-attributed sales can revise and are not incremental sales. Residual sales are not exact organic sales.`;
}

function exceptionRead(item) {
  const action = String(item.action || '').toUpperCase(),
    cover = Number(item.days_cover);
  if (action === 'STOCKOUT') return { severity: 'critical', label: 'Critical', reason: 'No sellable stock' };
  if (action === 'PRODUCE')
    return { severity: 'urgent', label: 'Produce now', reason: 'Below production threshold' };
  if (Number.isFinite(cover) && cover <= 21)
    return { severity: 'urgent', label: 'Plan soon', reason: 'Inside the near-term planning window' };
  return { severity: 'watch', label: 'Watch', reason: 'Approaching the planning window' };
}

function renderAttention(data, decisionCount) {
  const attention = (data.inventory || []).filter((item) =>
    ['STOCKOUT', 'PRODUCE', 'PLAN'].includes(String(item.action || '').toUpperCase()),
  );
  const title = document.getElementById('attentionTitle'),
    copy = document.getElementById('attentionCopy'),
    container = document.getElementById('attention');
  if (!attention.length) {
    title.textContent = 'Nothing needs attention';
    copy.textContent = 'No stockout, production or planning exception is currently flagged.';
    container.innerHTML =
      '<div class="attention-clear"><strong>Operations are clear.</strong><p>Demand and business health show no immediate inventory action.</p></div>';
    return;
  }
  const total = Math.max(attention.length, decisionCount),
    visible = attention.slice(0, 4);
  title.textContent = total === 1 ? 'One decision needs attention' : `${total} decisions need attention`;
  copy.textContent = `Review ${total === 1 ? 'this inventory exception' : 'these inventory exceptions'} before the next availability and production decision.`;
  container.innerHTML = `${visible
    .map((item) => {
      const read = exceptionRead(item);
      return `<a class="attention-item severity-${read.severity}" href="/inventory"><div class="attention-item__body"><div class="attention-item__head"><span class="severity-badge severity-badge--${read.severity}">${read.label}</span><span class="sku">${escapeHtml(item.sku)}</span></div><div class="name">${escapeHtml(item.product || item.sku)}</div><div class="meta">${integer(item.available)} on hand · ${integer(item.inbound)} inbound</div><div class="attention-reason">${read.reason}</div></div><div class="attention-cover"><strong>${item.days_cover == null ? '—' : Number(item.days_cover).toFixed(0)}</strong><span>days cover</span></div></a>`;
    })
    .join(
      '',
    )}${total > visible.length ? `<a class="attention-more" href="/inventory"><span>Review all inventory decisions</span><strong>${integer(total - visible.length)} more →</strong></a>` : ''}`;
}

function monthLabel(value) {
  return formatMonthYear(value, { fallback: 'Latest month' });
}

function renderBusinessHealth(data) {
  const finance = data.finance || {},
    inventory = data.inventory_summary || {},
    health = data.health_contract || {},
    pipeline = health.pipeline_scope || {},
    overall = health.overall || {},
    conditionCount = Number(overall.active_condition_count || 0),
    affectedDomains = Array.isArray(overall.affected_domains) ? overall.affected_domains : [],
    healthNeedsAttention = overall.state !== 'healthy',
    contribution = finance.contribution_after_product_cogs,
    margin = finance.contribution_margin_pct,
    needsAction = Number(inventory.needs_action || 0),
    financeTone = contribution == null ? '' : Number(contribution) >= 0 ? 'positive' : 'negative',
    container = document.getElementById('businessHealth');
  container.innerHTML = `
    <a class="business-health-card" href="/finance">
      <div class="business-health-card__head"><span>Finance</span><span>${escapeHtml(String(finance.state || 'Not closed').replaceAll('_', ' '))}</span></div>
      <strong class="business-health-card__value ${financeTone}">${contribution == null ? '—' : money(contribution)}</strong>
      <div class="business-health-card__title">${escapeHtml(monthLabel(finance.month))} contribution</div>
      <p>${margin == null ? 'No closed margin available yet.' : `${Number(margin).toFixed(1)}% after product COGS · net sales ex IVA`}</p>
    </a>
    <a class="business-health-card" href="/inventory">
      <div class="business-health-card__head"><span>Inventory</span><span>${needsAction ? 'Action required' : 'Clear'}</span></div>
      <strong class="business-health-card__value ${needsAction ? 'warning' : 'positive'}">${needsAction ? integer(needsAction) : 'Clear'}</strong>
      <div class="business-health-card__title">Operating decisions</div>
      <p>${integer(inventory.stockouts)} stockouts · ${integer(inventory.produce)} produce · ${integer(inventory.plan)} plan</p>
    </a>
    <a class="business-health-card" href="/data-health">
      <div class="business-health-card__head"><span>Data confidence</span><span>${healthNeedsAttention ? 'Inspect' : 'Healthy'}</span></div>
      <strong class="business-health-card__value ${healthNeedsAttention ? 'warning' : 'positive'}">${pipeline.total ? `${integer(pipeline.healthy)}/${integer(pipeline.total)}` : '—'}</strong>
      <div class="business-health-card__title">Core input pipelines healthy</div>
      <p>${!pipeline.total ? 'No shared data-health contract is available.' : conditionCount ? `${integer(conditionCount)} active data condition${conditionCount === 1 ? '' : 's'} affect${conditionCount === 1 ? 's' : ''} ${escapeHtml(affectedDomains.join(', ') || 'a decision domain')}. Supporting jobs and optional Ads sit outside this six-stream count.` : 'Core pipelines and decision domains are inside contract. Supporting jobs and optional Ads sit outside this six-stream count.'}</p>
    </a>`;
}

function businessLead(read = {}) {
  const explanation = String(read.explanation || '').trim();
  const sentences = explanation.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
  const headline = String(sentences.shift() || 'Current business performance').trim();
  return {
    headline,
    detail: sentences.join(' ').trim() || 'Current demand and operating exceptions are shown below.',
  };
}

function render(data) {
  const today = data.today || {},
    rolling = data.rolling || {},
    inventory = data.inventory_summary || {},
    decisionCount = Number(inventory.needs_action || 0),
    read = data.business_momentum || {},
    lead = businessLead(read);
  document.getElementById('clock').textContent = formatBusinessClock(data.local_time);
  document.getElementById('fresh').textContent = 'Live operating data';
  document.getElementById('stateHeadline').textContent = lead.headline;
  document.getElementById('stateCopy').textContent = lead.detail;
  document.getElementById('homeBusinessWindow').textContent = formatMetricWindow(
    data.metric_windows?.RECONCILED_BUSINESS_T28,
  );
  mountRuleTrigger(document.getElementById('stateHeadline'), read, data.interpretation_rules);
  document.getElementById('sales28').textContent = money(rolling.sales_t28);
  document.getElementById('sales28Note').textContent = 'incl. IVA · Sales & Traffic';
  const momentum = document.getElementById('momentum');
  momentum.textContent = percent(rolling.delta28_pct);
  momentum.className = `kpi__value ${tone(rolling.delta28_pct)}`;
  document.getElementById('momentumNote').textContent = 'vs prior 28 · same gross basis';
  document.getElementById('todaySales').textContent = money(today.sales_today);
  document.getElementById('todayNote').textContent =
    `incl. IVA · ${formatCount(today.orders_today, 'order')} · ${formatCount(today.units_today, 'unit')}`;
  document.getElementById('decisionCount').textContent = integer(decisionCount);
  document.getElementById('decisionNote').textContent =
    decisionCount === 1 ? 'current operating flag' : 'current operating flags';
  document.getElementById('attentionCount').textContent = integer(decisionCount);
  renderAds(data.ads);
  renderAttention(data, decisionCount);
  renderBusinessHealth(data);
  if (window.DPPCharts?.homeRhythm) {
    const cutoff = String(rolling.business_date || '').slice(0, 10),
      reconciledSeries = (data.series || []).filter(
        (row) => !cutoff || String(row.business_date || '').slice(0, 10) <= cutoff,
      );
    window.DPPCharts.homeRhythm('#spark', reconciledSeries, data.weekly_products);
  }
}
async function load() {
  try {
    render(await fetchJson('/api/home'));
  } catch (error) {
    document.getElementById('stateHeadline').textContent = 'Operating feed unavailable';
    document.getElementById('stateCopy').textContent = error.message;
  }
}
load();
setInterval(load, 60_000);
