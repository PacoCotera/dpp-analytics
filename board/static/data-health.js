import { byId, escapeHtml, fetchJson, integer } from './ui-utils.js';

let jobs = [];
let expanded = false;

const criticalSources = new Set(['orders', 'data_kiosk', 'inventory', 'finances', 'catalog', 'listings']);

function age(seconds) {
  const value = Number(seconds || 0);
  if (value < 60) return `${Math.round(value)}s`;
  if (value < 3600) return `${Math.round(value / 60)}m`;
  if (value < 86400) return `${(value / 3600).toFixed(value < 10800 ? 1 : 0)}h`;
  return `${(value / 86400).toFixed(value < 259200 ? 1 : 0)}d`;
}

function jobState(item) {
  if (item.latest_status === 'error') return 'failed';
  if (item.latest_status === 'interrupted') return 'degraded';
  if (Number(item.age_seconds || 0) > 86400) return 'stale';
  if (['success', 'running'].includes(item.latest_status)) return 'healthy';
  return 'degraded';
}

function statusClass(status) {
  return ['success', 'running', 'error', 'interrupted'].includes(status) ? status : '';
}

function problemJobs() {
  return jobs.filter(item => jobState(item) !== 'healthy').slice(0, 8);
}

function sourceMatches(item, names) {
  const haystack = `${item.source || ''} ${item.job_name || ''}`.toLowerCase();
  return names.some(name => haystack.includes(name));
}

function worstState(rows) {
  const rank = { healthy: 0, stale: 1, degraded: 2, failed: 3 };
  return rows.reduce((state, row) => (rank[jobState(row)] > rank[state] ? jobState(row) : state), 'healthy');
}

function decisionDomains(payload) {
  const adsState = payload.ads?.summary?.state || 'AWAITING_DATA';
  const domains = [
    { name: 'Sales & Today', sources: ['orders', 'data kiosk', 'sales'], affects: 'Today, Home, Sales, Trajectory' },
    { name: 'Inventory', sources: ['inventory'], affects: 'Inventory, Product availability' },
    { name: 'Finance', sources: ['finance', 'settlement'], affects: 'Finance, contribution context' },
    { name: 'Catalog', sources: ['catalog', 'listing'], affects: 'Products, Catalog identity' },
  ].map(domain => {
    const rows = jobs.filter(item => sourceMatches(item, domain.sources));
    return { ...domain, state: rows.length ? worstState(rows) : 'degraded', count: rows.length };
  });

  domains.push({
    name: 'Advertising',
    state: adsState === 'HEALTHY' ? 'healthy' : adsState === 'ATTENTION' ? 'degraded' : 'disconnected',
    affects: adsState === 'AWAITING_DATA' ? 'Ads-dependent interpretation only' : 'Ads, Product and Finance attribution context',
    count: Number(payload.ads?.summary?.accounts || 0),
  });
  return domains;
}

function renderDomains(payload) {
  byId('domains').innerHTML = decisionDomains(payload)
    .map(domain => `<article class="domain-card domain-card--${domain.state}">
      <div class="domain-card__head"><strong>${escapeHtml(domain.name)}</strong><span>${escapeHtml(domain.state)}</span></div>
      <p>${escapeHtml(domain.affects)}</p>
    </article>`)
    .join('');
}

function renderJobs() {
  const rows = expanded ? jobs : problemJobs();
  if (!rows.length && !expanded) {
    byId('jobs').innerHTML = '<div class="empty"><strong>No problem jobs.</strong> Decision-critical pipeline jobs currently need no attention.</div>';
    return;
  }

  byId('jobs').innerHTML = rows
    .map(item => `<div class="health-job">
      <div><div class="health-job__name">${escapeHtml(item.job_name || '')}</div><div class="health-job__source">${escapeHtml(item.source || '')}</div></div>
      <div><span class="health-status ${statusClass(item.latest_status)}">${escapeHtml(item.latest_status || 'unknown')}</span></div>
      <div class="health-job__age">${age(item.age_seconds)}</div>
      <div class="health-job__rows">${item.records_written == null ? '—' : integer(item.records_written)} written</div>
      <div class="health-job__error" title="${escapeHtml(item.error_message || '')}">${escapeHtml(item.error_message || '')}</div>
    </div>`)
    .join('');
}

function render(payload) {
  jobs = payload.jobs || [];
  const warehouse = payload.warehouse || {};
  const critical = jobs.filter(item => criticalSources.has(String(item.source || '').toLowerCase()) || sourceMatches(item, ['order', 'data kiosk', 'inventory', 'finance', 'catalog', 'listing']));
  const healthyCritical = critical.filter(item => jobState(item) === 'healthy').length;
  const ratio = critical.length ? healthyCritical / critical.length : 0;
  const score = Math.round(ratio * 100);
  const criticalProblems = critical.filter(item => jobState(item) !== 'healthy');
  const adsState = payload.ads?.summary?.state || 'AWAITING_DATA';

  byId('clock').textContent = payload.local_time || '--:--';
  byId('score').textContent = `${score}%`;
  byId('ring').style.setProperty('--angle', `${ratio * 360}deg`);

  if (!criticalProblems.length) {
    byId('healthTitle').textContent = 'Core seller decisions are supported.';
    byId('healthCopy').textContent = `${healthyCritical} of ${critical.length} decision-critical pipeline jobs are current and healthy.`;
    byId('trustNote').textContent = adsState === 'AWAITING_DATA'
      ? 'Today, Sales, Inventory, Catalog and Finance can be used normally. Advertising is not yet available, so Ads-dependent attribution and interpretation remain intentionally limited.'
      : 'Decision-critical seller data is current. Optional domain limitations are shown separately below.';
  } else {
    byId('healthTitle').textContent = `${criticalProblems.length} decision-critical source${criticalProblems.length === 1 ? '' : 's'} need attention.`;
    byId('healthCopy').textContent = 'Use the decision-domain map below to see which product surfaces are affected before acting.';
    byId('trustNote').textContent = 'Trust is scoped by domain. An affected source does not invalidate unrelated seller decisions.';
  }

  [['orders', 'orders'], ['financial_transactions', 'finance'], ['seller_listings', 'listings'], ['inventory_snapshots', 'snapshots']].forEach(([key, id]) => {
    byId(id).textContent = integer(warehouse[key]);
  });

  renderDomains(payload);
  renderJobs();
}

function bindInteractions() {
  byId('toggle').addEventListener('click', () => {
    expanded = !expanded;
    byId('toggle').textContent = expanded ? 'Show problems only' : 'Show all jobs';
    byId('toggle').setAttribute('aria-pressed', String(expanded));
    renderJobs();
  });
}

async function start() {
  bindInteractions();
  try {
    render(await fetchJson('/api/data-health'));
  } catch (error) {
    byId('healthTitle').textContent = 'Data health unavailable';
    byId('healthCopy').textContent = error.message;
  }
}

start();
