import { byId, escapeHtml, fetchJson, integer } from './ui-utils.js';

let jobs = [];
let expanded = false;

const DOMAIN_DEFINITIONS = [
  {
    key: 'today',
    label: 'Today',
    affects: 'Live sales, orders and day-state decisions',
    terms: ['orders'],
    critical: true,
  },
  {
    key: 'sales',
    label: 'Sales',
    affects: 'Historical sales, momentum and product contribution',
    terms: ['data_kiosk', 'data kiosk'],
    critical: true,
  },
  {
    key: 'products',
    label: 'Products',
    affects: 'Catalog identity, offer state and product drill-down',
    terms: ['catalog', 'seller_listings', 'seller listings'],
    critical: true,
  },
  {
    key: 'inventory',
    label: 'Inventory',
    affects: 'Stock position, cover and replenishment actions',
    terms: ['inventory'],
    critical: true,
  },
  {
    key: 'finance',
    label: 'Finance',
    affects: 'Accounting periods, Amazon postings and contribution',
    terms: ['finance', 'settlement'],
    critical: true,
  },
];

function age(seconds) {
  const value = Number(seconds || 0);
  if (value < 60) return `${Math.round(value)}s`;
  if (value < 3600) return `${Math.round(value / 60)}m`;
  if (value < 86400) return `${(value / 3600).toFixed(value < 10800 ? 1 : 0)}h`;
  return `${(value / 86400).toFixed(value < 259200 ? 1 : 0)}d`;
}

function normalizedJobText(item) {
  return `${item.source || ''} ${item.job_name || ''}`.toLowerCase().replaceAll('-', '_');
}

function jobState(item) {
  const status = item.latest_status || 'unknown';
  if (status === 'error') return 'failed';
  if (status === 'interrupted') return 'degraded';
  if (Number(item.age_seconds || 0) > 86400) return 'stale';
  if (status === 'success' || status === 'running') return 'healthy';
  return 'degraded';
}

function worstState(states) {
  const rank = { failed: 4, stale: 3, degraded: 2, healthy: 1, disconnected: 0 };
  return states.reduce((worst, state) => (rank[state] > rank[worst] ? state : worst), 'disconnected');
}

function domainState(definition) {
  const matched = jobs.filter((item) => {
    const text = normalizedJobText(item);
    return definition.terms.some((term) => text.includes(term.replaceAll('-', '_')));
  });
  if (!matched.length) return { ...definition, state: 'disconnected', jobs: [] };
  return { ...definition, state: worstState(matched.map(jobState)), jobs: matched };
}

function buildDomains(payload) {
  const core = DOMAIN_DEFINITIONS.map(domainState);
  const ads = payload.ads?.summary || {};
  const adsState =
    ads.state === 'HEALTHY' ? 'healthy' : ads.state === 'ATTENTION' ? 'degraded' : 'disconnected';
  core.push({
    key: 'ads',
    label: 'Ads',
    affects: 'Paid-media efficiency and attributed advertising decisions',
    state: adsState,
    jobs: [],
    critical: false,
  });
  return core;
}

function stateLabel(state) {
  return (
    {
      healthy: 'Healthy',
      stale: 'Stale',
      degraded: 'Degraded',
      failed: 'Failed',
      disconnected: 'Not configured',
    }[state] || 'Unknown'
  );
}

function stateCopy(domain) {
  if (domain.state === 'healthy') return 'Decision-ready';
  if (domain.state === 'stale') return 'Source is older than expected';
  if (domain.state === 'failed') return 'Wait before relying on this domain';
  if (domain.state === 'degraded') return 'Use with caution';
  return domain.critical ? 'Required source not detected' : 'Optional domain unavailable';
}

function renderDomains(domains) {
  byId('domains').innerHTML = domains
    .map(
      (domain) => `<article class="domain-card domain-card--${domain.state}">
      <div class="domain-card__head">
        <strong>${escapeHtml(domain.label)}</strong>
        <span class="domain-state domain-state--${domain.state}">${stateLabel(domain.state)}</span>
      </div>
      <p>${escapeHtml(domain.affects)}</p>
      <small>${escapeHtml(stateCopy(domain))}</small>
    </article>`,
    )
    .join('');
}

function problemJobs() {
  return jobs.filter((item) => jobState(item) !== 'healthy').slice(0, 8);
}

function renderJobs() {
  const rows = expanded ? jobs : problemJobs();

  if (!rows.length && !expanded) {
    byId('jobs').innerHTML =
      '<div class="empty"><strong>No pipeline exceptions.</strong> Technical source detail is quiet because no tracked job needs attention.</div>';
    return;
  }

  byId('jobs').innerHTML = rows
    .map(
      (item) => `<div class="health-job">
      <div>
        <div class="health-job__name">${escapeHtml(item.job_name || '')}</div>
        <div class="health-job__source">${escapeHtml(item.source || '')}</div>
      </div>
      <div><span class="health-status ${jobState(item)}">${stateLabel(jobState(item))}</span></div>
      <div class="health-job__age">${age(item.age_seconds)}</div>
      <div class="health-job__rows">${item.records_written == null ? '—' : integer(item.records_written)}</div>
      <div class="health-job__error" title="${escapeHtml(item.error_message || '')}">${escapeHtml(item.error_message || '—')}</div>
    </div>`,
    )
    .join('');
}

function render(payload) {
  jobs = payload.jobs || [];
  const warehouse = payload.warehouse || {};
  const domains = buildDomains(payload);
  const critical = domains.filter((domain) => domain.critical);
  const healthyCritical = critical.filter((domain) => domain.state === 'healthy').length;
  const ratio = critical.length ? healthyCritical / critical.length : 0;
  const score = Math.round(ratio * 100);
  const blocked = critical.filter((domain) => ['failed', 'disconnected'].includes(domain.state));
  const caution = critical.filter((domain) => ['stale', 'degraded'].includes(domain.state));
  const optionalUnavailable = domains.filter((domain) => !domain.critical && domain.state !== 'healthy');

  byId('clock').textContent = payload.local_time || '--:--';
  byId('score').textContent = `${score}%`;
  byId('ring').style.setProperty('--angle', `${ratio * 360}deg`);
  byId('ring').dataset.state = blocked.length ? 'failed' : caution.length ? 'degraded' : 'healthy';

  if (blocked.length) {
    byId('healthTitle').textContent =
      `${blocked.length} decision domain${blocked.length === 1 ? ' is' : 's are'} not ready.`;
    byId('healthCopy').textContent =
      `${healthyCritical} of ${critical.length} decision-critical domains are healthy. ${blocked.map((domain) => domain.label).join(', ')} should not be treated as decision-ready.`;
    byId('trustNote').textContent =
      'Use healthy domains normally. Wait on the affected business surface until its required source recovers.';
  } else if (caution.length) {
    byId('healthTitle').textContent = 'Core decisions are available with caveats.';
    byId('healthCopy').textContent =
      `${healthyCritical} of ${critical.length} decision-critical domains are fully healthy; ${caution.map((domain) => domain.label).join(', ')} ${caution.length === 1 ? 'needs' : 'need'} caution.`;
    byId('trustNote').textContent =
      'The board is usable, but inspect the affected domain before making a time-sensitive decision.';
  } else {
    byId('healthTitle').textContent = 'Core seller decisions are supported.';
    byId('healthCopy').textContent =
      `All ${critical.length} decision-critical domains are healthy.${optionalUnavailable.length ? ` ${optionalUnavailable.map((domain) => domain.label).join(', ')} is optional and currently unavailable.` : ''}`;
    byId('trustNote').textContent =
      'Today remains provisional by design; historical Sales and Finance retain their own reconciliation and close-state semantics.';
  }

  renderDomains(domains);

  const warehouseKeys = [
    ['orders', 'orders'],
    ['financial_transactions', 'finance'],
    ['seller_listings', 'listings'],
    ['inventory_snapshots', 'snapshots'],
  ];
  warehouseKeys.forEach(([key, id]) => {
    byId(id).textContent = integer(warehouse[key]);
  });

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
    byId('score').textContent = '—';
  }
}

start();
