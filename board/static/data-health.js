import { byId, escapeHtml, fetchJson, integer } from './ui-utils.js';

let jobs = [];
let expanded = false;

const DOMAIN_DEFINITIONS = [
  {
    key: 'today',
    label: 'Today',
    terms: ['orders'],
    critical: true,
  },
  {
    key: 'sales',
    label: 'Sales',
    terms: ['data_kiosk', 'data kiosk'],
    critical: true,
  },
  {
    key: 'products',
    label: 'Products',
    terms: ['catalog', 'seller_listings', 'seller listings'],
    critical: true,
  },
  {
    key: 'inventory',
    label: 'Inventory',
    terms: ['inventory'],
    critical: true,
  },
  {
    key: 'finance',
    label: 'Finance',
    terms: ['finance', 'settlement'],
    critical: true,
  },
];

function duration(seconds, compact = false) {
  const value = Math.max(0, Number(seconds || 0));
  if (value < 60) return `${Math.round(value)}s`;
  if (value < 3600) return `${Math.round(value / 60)}m`;
  if (value < 86400) {
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    return compact || !minutes ? `${hours}h` : `${hours}h ${minutes}m`;
  }
  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  return compact || !hours ? `${days}d` : `${days}d ${hours}h`;
}

function timestamp(value) {
  if (!value) return 'No successful run recorded';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('en-MX', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function normalizedJobText(item) {
  return `${item.source || ''} ${item.job_name || ''}`.toLowerCase().replaceAll('-', '_');
}

function jobState(item) {
  const status = item.latest_status || 'unknown';
  if (status === 'error') return 'failed';
  if (item.is_stale) return 'stale';
  if (status === 'interrupted') return 'degraded';
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

function renderDomains(domains) {
  const caution = domains.filter((domain) => domain.critical && domain.state !== 'healthy');
  const ready = domains.filter((domain) => domain.critical && domain.state === 'healthy');
  const optional = domains.filter((domain) => !domain.critical);
  const group = (label, state, rows) => {
    if (!rows.length) return '';
    return `<div class="domain-group domain-group--${state}">
      <span class="domain-group__label">${escapeHtml(label)}</span>
      <div class="domain-chips">
        ${rows
          .map(
            (domain) => `<span class="domain-chip domain-chip--${domain.state}">
              <strong>${escapeHtml(domain.label)}</strong>
              <small>${stateLabel(domain.state)}</small>
            </span>`,
          )
          .join('')}
      </div>
    </div>`;
  };
  byId('domains').innerHTML = [
    group('Needs caution', 'attention', caution),
    group('Decision-ready', 'ready', ready),
    group('Optional', 'optional', optional),
  ].join('');
}

function problemJobs() {
  return jobs.filter((item) => jobState(item) !== 'healthy');
}

function scheduleCopy(item) {
  if (item.latest_status === 'running') return `Running for ${duration(item.attempt_age_seconds)}`;
  if (Number(item.next_due_in_seconds || 0) > 0) {
    return `Next due in ${duration(item.next_due_in_seconds)}`;
  }
  return `Overdue by ${duration(item.overdue_by_seconds)}`;
}

function latestDiagnostic(item) {
  if (item.error_message) return item.error_message;
  if (item.latest_attempt_status === 'interrupted') {
    return 'The last attempt was interrupted by a worker restart. A prior successful result is still available.';
  }
  if (item.is_stale) {
    return 'No API error was recorded. The last successful fetch is older than this stream’s cadence and grace period.';
  }
  return 'No API error recorded on the latest attempt.';
}

function renderAttention() {
  const problems = problemJobs();
  byId('attentionSection').hidden = !problems.length;
  if (!problems.length) {
    byId('attention').innerHTML = '';
    return;
  }

  byId('attention').innerHTML = problems
    .map((item) => {
      const state = jobState(item);
      const rowsRead = item.records_read == null ? '—' : integer(item.records_read);
      const rowsWritten = item.records_written == null ? '—' : integer(item.records_written);
      return `<article class="incident incident--${state}">
        <header class="incident__header">
          <div>
            <span class="incident__operation">${escapeHtml(item.operation || item.source || '')}</span>
            <h3>${escapeHtml(item.label || item.job_name || '')}</h3>
          </div>
          <span class="health-status ${state}">${stateLabel(state)}</span>
        </header>
        <p class="incident__purpose">${escapeHtml(item.purpose || '')}</p>
        <div class="incident__impact">Impacts <strong>${escapeHtml(item.domain || 'Warehouse')}</strong></div>
        <dl class="incident__metrics">
          <div>
            <dt>Data age</dt>
            <dd>${duration(item.age_seconds)} old</dd>
            <small>Last success ${timestamp(item.last_success_at)}</small>
          </div>
          <div>
            <dt>Expected cadence</dt>
            <dd>Every ${duration(item.expected_interval_seconds)}</dd>
            <small>Stale after ${duration(item.stale_after_seconds)}</small>
          </div>
          <div>
            <dt>Current wait</dt>
            <dd>${scheduleCopy(item)}</dd>
            <small>Waiting for ${escapeHtml(item.waiting_for || 'the next collection')}</small>
          </div>
          <div>
            <dt>Last fetch</dt>
            <dd>${rowsRead} read · ${rowsWritten} stored</dd>
            <small>Attempt ${timestamp(item.last_started_at)}</small>
          </div>
        </dl>
        <div class="incident__diagnostic ${item.error_message ? 'incident__diagnostic--error' : ''}">
          <span>${item.error_message ? 'Latest API / ingestion error' : 'Diagnostic'}</span>
          <strong>${escapeHtml(latestDiagnostic(item))}</strong>
          ${item.last_error_at && !item.error_message ? `<small>Previous error ${timestamp(item.last_error_at)}: ${escapeHtml(item.last_error_message || 'No message')}</small>` : ''}
        </div>
      </article>`;
    })
    .join('');
}

function renderJobs() {
  const rows = expanded ? jobs : problemJobs();

  if (!rows.length && !expanded) {
    byId('jobs').innerHTML =
      '<div class="empty"><strong>No pipeline exceptions.</strong> Every tracked stream is inside its own cadence and grace period.</div>';
    return;
  }

  byId('jobs').innerHTML = rows
    .map(
      (item) => `<div class="health-job">
      <div>
        <div class="health-job__name">${escapeHtml(item.label || item.job_name || '')}</div>
        <div class="health-job__source">${escapeHtml(item.operation || item.source || '')}</div>
      </div>
      <div><span class="health-status ${jobState(item)}">${stateLabel(jobState(item))}</span></div>
      <div class="health-job__age">${duration(item.age_seconds)}<small>${timestamp(item.last_success_at)}</small></div>
      <div class="health-job__cadence">${duration(item.expected_interval_seconds)}<small>${scheduleCopy(item)}</small></div>
      <div class="health-job__rows">${item.records_read == null ? '—' : integer(item.records_read)} read · ${item.records_written == null ? '—' : integer(item.records_written)} stored</div>
    </div>`,
    )
    .join('');
}

function render(payload) {
  jobs = payload.jobs || [];
  const warehouse = payload.warehouse || {};
  const domains = buildDomains(payload);
  const critical = domains.filter((domain) => domain.critical);
  const caution = critical.filter((domain) => domain.state !== 'healthy');
  const problems = problemJobs();

  byId('clock').textContent = payload.local_time || '--:--';
  byId('healthUpdated').textContent = `Health checked ${timestamp(payload.checked_at)} · refreshes every 60s`;
  byId('summaryCount').textContent = String(problems.length);
  byId('summaryCount').dataset.state = problems.some((item) => jobState(item) === 'failed')
    ? 'failed'
    : problems.length
      ? 'degraded'
      : 'healthy';

  if (problems.length) {
    byId('summaryEyebrow').textContent =
      `${problems.length} stream${problems.length === 1 ? '' : 's'} outside contract`;
    byId('healthTitle').textContent =
      `${problems.length} data stream${problems.length === 1 ? ' needs' : 's need'} attention.`;
    byId('healthCopy').textContent = caution.length
      ? `${caution.map((domain) => domain.label).join(', ')} ${caution.length === 1 ? 'is' : 'are'} affected. The exact source condition and last API attempt are below.`
      : 'The affected stream is not currently blocking a decision-critical business surface.';
  } else {
    byId('summaryEyebrow').textContent = 'All streams inside contract';
    byId('healthTitle').textContent = 'Decision-critical data is current.';
    byId('healthCopy').textContent =
      `All ${critical.length} decision surfaces are supported within each source’s own cadence and grace period.`;
  }

  renderAttention();
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

async function refresh() {
  try {
    render(await fetchJson('/api/data-health'));
  } catch (error) {
    byId('summaryCount').textContent = '!';
    byId('summaryCount').dataset.state = 'failed';
    byId('summaryEyebrow').textContent = 'Health API unavailable';
    byId('healthTitle').textContent = 'Data health unavailable';
    byId('healthCopy').textContent = error.message;
    byId('healthUpdated').textContent = 'Automatic refresh will retry in 60s.';
  }
}

function start() {
  bindInteractions();
  refresh();
  window.setInterval(refresh, 60_000);
}

start();
