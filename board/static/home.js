import { escapeHtml, fetchJson, formatBusinessClock, integer, money, percent, tone } from './ui-utils.js';

function stateRead(delta, actions) {
  const momentum = Number(delta || 0),
    decisionCount = Number(actions || 0);
  const decisionCopy = decisionCount
    ? `${decisionCount} operating decision${decisionCount === 1 ? ' needs' : 's need'} attention.`
    : '';
  if (momentum >= 8)
    return {
      headline: 'Momentum is strong.',
      copy: decisionCount
        ? `The last four weeks of shopper spend are clearly ahead of the prior four. ${decisionCopy}`
        : 'The last four weeks of shopper spend are clearly ahead of the prior four, with nothing requiring immediate attention.',
    };
  if (momentum >= 2)
    return {
      headline: 'The business is growing.',
      copy: decisionCount
        ? `Recent shopper spend is modestly ahead. ${decisionCopy}`
        : 'Recent shopper spend is modestly ahead and there are no immediate operating exceptions.',
    };
  if (momentum > -2)
    return {
      headline: 'The business is steady.',
      copy: decisionCount
        ? `Recent shopper spend is essentially flat. ${decisionCopy}`
        : 'Recent shopper spend is essentially flat and operations are currently clear.',
    };
  if (momentum > -8)
    return {
      headline: 'Momentum has softened.',
      copy: decisionCount
        ? `The last four weeks of shopper spend are below the prior four. ${decisionCount} operating decision${decisionCount === 1 ? ' also needs' : 's also need'} attention.`
        : 'The last four weeks of shopper spend are below the prior four, but no immediate operating exception is flagged.',
    };
  return {
    headline: 'The business is cooling.',
    copy: decisionCount
      ? `Recent shopper spend is meaningfully below the prior four weeks and ${decisionCopy}`
      : 'Recent shopper spend is meaningfully below the prior four weeks. Operations themselves are currently clear.',
  };
}

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
      '<div class="attention-clear"><strong>Operations are clear.</strong><p>Use the demand pulse and business-health evidence to understand performance; there is no immediate inventory action.</p></div>';
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
  if (!value) return 'Latest month';
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.getTime())
    ? String(value).slice(0, 7)
    : date.toLocaleDateString('en', { month: 'short', year: 'numeric' });
}

function renderBusinessHealth(data) {
  const finance = data.finance || {},
    inventory = data.inventory_summary || {},
    feeds = data.freshness || [],
    feedIssues = feeds.filter(
      (feed) =>
        feed.is_stale || !['success', 'running'].includes(String(feed.latest_status || '').toLowerCase()),
    ),
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
      <div class="business-health-card__head"><span>Data confidence</span><span>${feedIssues.length ? 'Inspect' : 'Healthy'}</span></div>
      <strong class="business-health-card__value ${feedIssues.length ? 'warning' : 'positive'}">${feeds.length ? `${integer(feeds.length - feedIssues.length)}/${integer(feeds.length)}` : '—'}</strong>
      <div class="business-health-card__title">Core streams healthy</div>
      <p>${!feeds.length ? 'No pipeline status is available.' : feedIssues.length ? `${integer(feedIssues.length)} stream${feedIssues.length === 1 ? '' : 's'} need attention.` : 'Operating evidence is current and decision-ready.'}</p>
    </a>`;
}

function render(data) {
  const today = data.today || {},
    rolling = data.rolling || {},
    inventory = data.inventory_summary || {},
    decisionCount = Number(inventory.needs_action || 0),
    read = stateRead(rolling.delta28_pct, decisionCount);
  document.getElementById('clock').textContent = formatBusinessClock(data.local_time);
  document.getElementById('fresh').textContent = 'Live operating data';
  document.getElementById('stateHeadline').textContent = read.headline;
  document.getElementById('stateCopy').textContent = read.copy;
  document.getElementById('sales28').textContent = money(rolling.sales_t28);
  document.getElementById('sales28Note').textContent = 'incl. IVA · Sales & Traffic';
  const momentum = document.getElementById('momentum');
  momentum.textContent = percent(rolling.delta28_pct);
  momentum.className = `kpi__value ${tone(rolling.delta28_pct)}`;
  document.getElementById('momentumNote').textContent = 'vs prior 28 · same gross basis';
  document.getElementById('todaySales').textContent = money(today.sales_today);
  document.getElementById('todayNote').textContent =
    `incl. IVA · ${integer(today.orders_today)} orders · ${integer(today.units_today)} units`;
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
