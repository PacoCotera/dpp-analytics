import { byId, escapeHtml, fetchJson, integer } from './ui-utils.js';

let jobs = [];
let expanded = false;

function age(seconds) {
  const value = Number(seconds || 0);
  if (value < 60) return `${Math.round(value)}s`;
  if (value < 3600) return `${Math.round(value / 60)}m`;
  if (value < 86400) return `${(value / 3600).toFixed(value < 10800 ? 1 : 0)}h`;
  return `${(value / 86400).toFixed(value < 259200 ? 1 : 0)}d`;
}

function statusClass(status) {
  return ['success', 'running', 'error', 'interrupted'].includes(status) ? status : '';
}

function problemJobs() {
  return jobs
    .filter(
      item =>
        item.latest_status === 'error' ||
        item.latest_status === 'interrupted' ||
        Number(item.age_seconds || 0) > 86400,
    )
    .slice(0, 8);
}

function renderJobs() {
  const rows = expanded ? jobs : problemJobs();

  if (!rows.length && !expanded) {
    byId('jobs').innerHTML = '<div class="empty"><strong>No problem jobs.</strong> Nothing in the source list currently needs your attention.</div>';
    return;
  }

  byId('jobs').innerHTML = rows
    .map(item => `<div class="health-job">
      <div>
        <div class="health-job__name">${escapeHtml(item.job_name || '')}</div>
        <div class="health-job__source">${escapeHtml(item.source || '')}</div>
      </div>
      <div><span class="health-status ${statusClass(item.latest_status)}">${escapeHtml(item.latest_status || 'unknown')}</span></div>
      <div class="health-job__age">${age(item.age_seconds)}</div>
      <div class="health-job__rows">${item.records_written == null ? '—' : integer(item.records_written)} written</div>
      <div class="health-job__error" title="${escapeHtml(item.error_message || '')}">${escapeHtml(item.error_message || '')}</div>
    </div>`)
    .join('');
}

function render(payload) {
  jobs = payload.jobs || [];
  const summary = payload.summary || {};
  const warehouse = payload.warehouse || {};
  const total = Number(summary.jobs || 0);
  const healthy = Number(summary.healthy || 0);
  const ratio = total ? healthy / total : 0;
  const score = Math.round(ratio * 100);
  const errors = Number(summary.errors || 0);
  const stale = Number(summary.stale || 0);

  byId('clock').textContent = payload.local_time || '--:--';
  byId('score').textContent = `${score}%`;
  byId('ring').style.setProperty('--angle', `${ratio * 360}deg`);

  let title;
  let copy;
  let note;

  if (errors === 0 && stale === 0) {
    title = 'The decision data is healthy.';
    copy = `${healthy} of ${total} tracked jobs are successful or running, with no stale feeds.`;
    note = 'Business pages are safe to use for their intended decisions. Today remains provisional by design; historical Sales uses reconciled Data Kiosk data.';
  } else if (errors === 0) {
    title = 'The system is healthy, with some stale sources.';
    copy = `No job is failing, but ${stale} source${stale === 1 ? ' is' : 's are'} older than 24 hours.`;
    note = 'Most decisions remain usable, but check the stale job list before acting on a domain that depends on it.';
  } else {
    title = `${errors} data job${errors === 1 ? ' needs' : 's need'} attention.`;
    copy = `${healthy} of ${total} tracked jobs are healthy. Review the problem jobs below before relying on the affected domain.`;
    note = 'Do not treat every pipeline error as a business emergency. Check whether the failed source actually feeds the decision you are making.';
  }

  byId('healthTitle').textContent = title;
  byId('healthCopy').textContent = copy;
  byId('trustNote').textContent = note;

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
  }
}

start();
