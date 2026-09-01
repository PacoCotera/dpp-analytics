import {
  byId,
  escapeHtml,
  fetchJson,
  formatBusinessClock,
  formatBusinessTimestamp,
  integer,
} from './ui-utils.js';

let jobs = [];
let expanded = false;
let catalogHealth = {};
let manualSyncPollTimer = null;
const manualSyncRequestErrors = new Map();
const trackedManualSyncJobs = new Set();

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

const timestamp = formatBusinessTimestamp;

function manualSyncPresentation(item) {
  const requestError = manualSyncRequestErrors.get(item.job_name);
  if (requestError) {
    return {
      button: 'Try again',
      detail: `Request failed · ${requestError}`,
      disabled: false,
      tone: 'failed',
    };
  }

  const status = item.manual_sync_status;
  const canRequest = item.manual_sync_can_request !== false;
  const wait = duration(item.manual_sync_cooldown_seconds, true);
  if (status === 'pending') {
    return {
      button: 'Queued',
      detail: 'Request queued · waiting for the worker',
      disabled: true,
      tone: 'queued',
    };
  }
  if (status === 'running') {
    return {
      button: 'Running…',
      detail: `Started ${timestamp(item.manual_sync_started_at)}`,
      disabled: true,
      tone: 'running',
    };
  }
  if (status === 'success' && !canRequest) {
    return {
      button: 'Completed',
      detail: `Completed · sync available in ${wait}`,
      disabled: true,
      tone: 'completed',
    };
  }
  if (status === 'error') {
    const failure = item.manual_sync_error_message || 'Last manual sync failed';
    return {
      button: canRequest ? 'Retry sync' : 'Failed',
      detail: canRequest ? `${failure} · retry available` : `${failure} · retry available in ${wait}`,
      disabled: !canRequest,
      tone: 'failed',
    };
  }
  return { button: 'Sync now', detail: '', disabled: !canRequest, tone: '' };
}

function announceManualSync(message) {
  byId('manualSyncStatus').textContent = message;
}

function announceManualSyncTransitions(previousJobs, nextJobs) {
  const previous = new Map(previousJobs.map((item) => [item.job_name, item]));
  nextJobs.forEach((item) => {
    if (!trackedManualSyncJobs.has(item.job_name)) return;
    const priorStatus = previous.get(item.job_name)?.manual_sync_status;
    const status = item.manual_sync_status;
    if (!status || status === priorStatus) return;
    const label = item.label || item.job_name;
    if (status === 'running') announceManualSync(`${label} sync is running.`);
    else if (status === 'success') announceManualSync(`${label} sync completed.`);
    else if (status === 'error') announceManualSync(`${label} sync failed.`);
  });
}

function scheduleManualSyncRefresh(delay = 2500) {
  if (manualSyncPollTimer !== null) return;
  manualSyncPollTimer = window.setTimeout(() => {
    manualSyncPollTimer = null;
    refresh({ force: true });
  }, delay);
}

function updateManualSyncPolling() {
  const active = jobs.some((item) => ['pending', 'running'].includes(item.manual_sync_status));
  if (active) scheduleManualSyncRefresh();
  else if (manualSyncPollTimer !== null) {
    window.clearTimeout(manualSyncPollTimer);
    manualSyncPollTimer = null;
  }
}

function applyManualSyncResponse(jobName, payload) {
  const item = jobs.find((job) => job.job_name === jobName);
  if (!item) return;
  item.manual_sync_request_id = payload.id;
  item.manual_sync_status = payload.status || 'pending';
  item.manual_sync_requested_at = payload.requested_at;
  item.manual_sync_started_at = payload.started_at;
  item.manual_sync_finished_at = payload.finished_at;
  item.manual_sync_error_message = payload.error_message;
  item.manual_sync_can_request = false;
  item.manual_sync_cooldown_seconds = Number(payload.retry_after_seconds || 0);
}

function jobState(item) {
  const status = item.latest_status || 'unknown';
  if (status === 'error') return 'failed';
  if (item.is_stale) return 'stale';
  if (status === 'interrupted') return 'degraded';
  if (status === 'success' || status === 'running') return 'healthy';
  return 'degraded';
}

function buildDomains(payload) {
  return Array.isArray(payload.health_contract?.domains) ? payload.health_contract.domains : [];
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
          <div><dt>Data age</dt><dd>${duration(item.age_seconds)} old</dd><small>Last success ${timestamp(item.last_success_at)}</small></div>
          <div><dt>Expected cadence</dt><dd>Every ${duration(item.expected_interval_seconds)}</dd><small>Stale after ${duration(item.stale_after_seconds)}</small></div>
          <div><dt>Current wait</dt><dd>${scheduleCopy(item)}</dd><small>Waiting for ${escapeHtml(item.waiting_for || 'the next collection')}</small></div>
          <div><dt>Rows read / stored</dt><dd>${rowsRead} read · ${rowsWritten} stored</dd><small>Attempt ${timestamp(item.last_started_at)}</small></div>
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

function catalogItemState(item) {
  if (item.source_attention) return { label: 'Source overdue', tone: 'failed' };
  if (item.taxonomy_state === 'MAPPING_REQUIRED') return { label: 'Map taxonomy', tone: 'degraded' };
  if (item.taxonomy_state === 'ONBOARDING') return { label: 'Onboarding', tone: 'onboarding' };
  return { label: 'Ready', tone: 'healthy' };
}

function catalogWaitCopy(item) {
  if (item.source_state === 'AWAITING_ASIN') {
    return 'Waiting for Amazon Seller Listings to expose an ASIN.';
  }
  if (item.source_state === 'AWAITING_CATALOG') {
    return 'ASIN known; Catalog enrichment is queued or has not completed yet.';
  }
  if (item.source_state === 'CATALOG_PROPAGATING') {
    return 'Catalog was queried, but Amazon has not returned complete enrichment yet.';
  }
  if (item.taxonomy_state === 'MAPPING_REQUIRED') {
    return 'Amazon source data is ready; add the seller-facing taxonomy mapping.';
  }
  return 'Catalog source and seller taxonomy are ready.';
}

function renderCatalogOnboarding(payload) {
  catalogHealth = payload.catalog || {};
  const summary = catalogHealth.summary || {};
  const items = (catalogHealth.items || []).filter(
    (item) => item.taxonomy_state === 'ONBOARDING' || item.requires_seller_action,
  );
  const section = byId('catalogOnboardingSection');
  const host = byId('catalogOnboarding');
  if (!section || !host) return;

  const onboarding = Number(summary.onboarding || 0);
  const attention = Number(summary.source_attention || 0) + Number(summary.taxonomy_attention || 0);
  section.hidden = onboarding === 0 && attention === 0;
  if (section.hidden) {
    host.innerHTML = '';
    return;
  }

  host.innerHTML = `<div class="catalog-health-summary">
      <div><strong>${integer(summary.source_ready || 0)}</strong><span>source ready</span></div>
      <div><strong>${integer(onboarding)}</strong><span>onboarding</span></div>
      <div><strong>${integer(summary.source_attention || 0)}</strong><span>source overdue</span></div>
      <div><strong>${integer(summary.taxonomy_attention || 0)}</strong><span>taxonomy action</span></div>
    </div>
    <div class="catalog-health-list">
      ${items
        .map((item) => {
          const state = catalogItemState(item);
          return `<article class="catalog-health-item catalog-health-item--${state.tone}">
            <div class="catalog-health-item__identity">
              <strong>${escapeHtml(item.sku || 'Unknown SKU')}</strong>
              <span>${escapeHtml(item.asin || 'ASIN pending')}</span>
            </div>
            <span class="health-status ${state.tone}">${escapeHtml(state.label)}</span>
            <div class="catalog-health-item__state">
              <strong>${escapeHtml(String(item.source_state || 'Unknown').replaceAll('_', ' '))}</strong>
              <span>${escapeHtml(catalogWaitCopy(item))}</span>
            </div>
            <div class="catalog-health-item__timing">
              <span>Seen ${duration(item.age_seconds)} ago</span>
              <span>Catalog attempt ${timestamp(item.catalog_last_attempt_at)}</span>
              <span>Enriched ${timestamp(item.catalog_enriched_at)}</span>
            </div>
          </article>`;
        })
        .join('')}
    </div>
    <p class="catalog-health-contract">New SKUs get a ${integer(summary.grace_hours || 48)}h propagation grace. When an ASIN is known but Catalog data is incomplete, enrichment retries every 30m.</p>`;
}

function renderJobs() {
  byId('toggle').textContent = expanded ? 'Problems only' : 'All jobs';
  byId('toggle').setAttribute('aria-expanded', String(expanded));
  const rows = expanded ? jobs : problemJobs();
  if (!rows.length && !expanded) {
    byId('jobs').innerHTML =
      '<div class="empty"><strong>No pipeline exceptions.</strong> Every tracked stream is inside its own cadence and grace period.</div>';
    return;
  }

  byId('jobs').innerHTML = rows
    .map((item) => {
      const sync = manualSyncPresentation(item);
      const jobName = escapeHtml(item.job_name || '');
      const statusId = `manual-sync-${jobName}`;
      return `<div class="health-job" role="row">
      <div class="health-job__identity" role="cell">
        <div class="health-job__name">${escapeHtml(item.label || item.job_name || '')}</div>
        <div class="health-job__source">${escapeHtml(item.operation || item.source || '')}</div>
        <div class="health-job__purpose">${escapeHtml(item.purpose || '')}</div>
        <div class="sync-control">
          <button class="btn sync-now" type="button" data-job="${jobName}" data-sync-status="${escapeHtml(item.manual_sync_status || 'idle')}"${sync.detail ? ` aria-describedby="${statusId}"` : ''}${sync.disabled ? ' disabled' : ''}>${escapeHtml(sync.button)}</button>
          ${sync.detail ? `<span class="sync-state${sync.tone ? ` sync-state--${sync.tone}` : ''}" id="${statusId}">${escapeHtml(sync.detail)}</span>` : ''}
        </div>
      </div>
      <div class="health-job__status" role="cell"><span class="health-status ${jobState(item)}">${stateLabel(jobState(item))}</span></div>
      <div class="health-job__age health-job__metric" role="cell">
        <span class="health-job__metric-label">Last successful run</span>
        <strong>${duration(item.age_seconds)} old</strong><small>Last success ${timestamp(item.last_success_at)}</small>
      </div>
      <div class="health-job__cadence health-job__metric" role="cell">
        <span class="health-job__metric-label">Frequency</span>
        <strong>Every ${duration(item.expected_interval_seconds)}</strong><small>${scheduleCopy(item)}</small>
      </div>
      <div class="health-job__rows health-job__metric" role="cell">
        <span class="health-job__metric-label">Rows read / stored</span>
        <strong>${item.records_read == null ? '—' : integer(item.records_read)} read · ${item.records_written == null ? '—' : integer(item.records_written)} stored</strong>
        <small>Attempt ${timestamp(item.last_started_at)}</small>
      </div>
    </div>`;
    })
    .join('');
}

function render(payload) {
  jobs = payload.jobs || [];
  const warehouse = payload.warehouse || {};
  const domains = buildDomains(payload);
  const contract = payload.health_contract || {};
  const overall = contract.overall || {};
  const critical = domains.filter((domain) => domain.critical);
  const caution = critical.filter((domain) => domain.state !== 'healthy');
  const catalogSummary = payload.catalog?.summary || {};
  const totalAttention = Number(overall.active_condition_count || 0);

  byId('clock').textContent = formatBusinessClock(payload.local_time);
  byId('healthUpdated').textContent = `Health checked ${timestamp(payload.checked_at)} · refreshes every 60s`;
  byId('summaryCount').textContent = String(totalAttention);
  byId('summaryCount').dataset.state = overall.state || 'degraded';

  if (totalAttention) {
    byId('summaryEyebrow').textContent =
      `${totalAttention} condition${totalAttention === 1 ? '' : 's'} outside contract`;
    byId('healthTitle').textContent =
      `${totalAttention} active data condition${totalAttention === 1 ? '' : 's'}`;
    byId('healthCopy').textContent = caution.length
      ? `${caution.map((domain) => domain.label).join(', ')} ${caution.length === 1 ? 'is' : 'are'} affected. Pipeline and catalog lifecycle detail are below.`
      : 'The affected condition is not currently blocking a decision-critical business surface.';
  } else {
    byId('summaryEyebrow').textContent = 'Decision data inside contract';
    byId('healthTitle').textContent = 'All decision data is current';
    byId('healthCopy').textContent = Number(catalogSummary.onboarding || 0)
      ? `All ${critical.length} decision surfaces are supported. ${catalogSummary.onboarding} new catalog item${Number(catalogSummary.onboarding) === 1 ? ' is' : 's are'} still inside normal Amazon propagation.`
      : `All ${critical.length} decision surfaces are supported within each source’s own cadence and grace period.`;
  }

  renderAttention();
  renderCatalogOnboarding(payload);
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

function syncWarehouseReference() {
  const reference = byId('warehouseReference');
  const summary = byId('warehouseReferenceSummary');
  const action = byId('warehouseReferenceAction');
  const label = reference.open ? 'Hide warehouse totals' : 'Show warehouse totals';
  summary.setAttribute('aria-label', label);
  action.textContent = label;
}

function bindInteractions() {
  byId('warehouseReference').addEventListener('toggle', syncWarehouseReference);
  syncWarehouseReference();
  byId('toggle').addEventListener('click', () => {
    expanded = !expanded;
    renderJobs();
  });
  byId('jobs').addEventListener('click', async (event) => {
    const button = event.target.closest('.sync-now');
    if (!button || button.disabled) return;
    const jobName = button.dataset.job;
    const label = jobs.find((item) => item.job_name === jobName)?.label || jobName;
    trackedManualSyncJobs.add(jobName);
    manualSyncRequestErrors.delete(jobName);
    button.disabled = true;
    button.textContent = 'Queueing…';
    announceManualSync(`Requesting ${label} sync.`);
    try {
      const response = await fetch('/api/manual-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_name: jobName }),
      });
      const payload = await response.json();
      if (!response.ok && !['cooldown', 'in_progress'].includes(payload.reason)) {
        throw new Error(payload.error || 'Request failed');
      }
      applyManualSyncResponse(jobName, payload);
      renderJobs();
      if (response.ok) announceManualSync(`${label} sync queued.`);
      else announceManualSync(`${label} sync was already requested; showing its current status.`);
      updateManualSyncPolling();
    } catch (error) {
      manualSyncRequestErrors.set(jobName, error.message);
      renderJobs();
      announceManualSync(`${label} sync request failed: ${error.message}`);
    }
  });
}

async function refresh({ force = false } = {}) {
  try {
    const payload = await fetchJson('/api/data-health', { forceRefresh: force });
    announceManualSyncTransitions(jobs, payload.jobs || []);
    render(payload);
    updateManualSyncPolling();
  } catch (error) {
    byId('summaryCount').textContent = '!';
    byId('summaryCount').dataset.state = 'failed';
    byId('summaryEyebrow').textContent = 'Health API unavailable';
    byId('healthTitle').textContent = 'Data health unavailable';
    byId('healthCopy').textContent = error.message;
    byId('healthUpdated').textContent = 'Automatic refresh will retry in 60s.';
    if (jobs.some((item) => ['pending', 'running'].includes(item.manual_sync_status))) {
      scheduleManualSyncRefresh(5000);
    }
  }
}

function start() {
  bindInteractions();
  refresh();
  window.setInterval(() => refresh(), 60_000);
}

start();
