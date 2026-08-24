import fs from 'node:fs/promises';
import path from 'node:path';

const outDir = process.argv[2] || '/out';
const baselinePath = process.argv[3] || '/qa/performance-baseline.json';

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

function pctDelta(current, baseline) {
  if (!Number.isFinite(current) || !Number.isFinite(baseline) || baseline === 0) return null;
  return ((current - baseline) / baseline) * 100;
}

function metricMinimum(metric, policy) {
  if (metric.endsWith('_ms')) return Number(policy.minimum_regression_ms || 75);
  if (metric.endsWith('_bytes')) return Number(policy.minimum_regression_bytes || 16_384);
  if (metric.endsWith('_requests')) return 1;
  return 0;
}

function compareMetric(metric, current, baseline, policy) {
  if (!Number.isFinite(current) || !Number.isFinite(baseline)) {
    return { metric, current, baseline, delta: null, delta_pct: null, state: 'unavailable' };
  }
  const delta = current - baseline;
  const deltaPct = pctDelta(current, baseline);
  const minimum = metricMinimum(metric, policy);
  const warningPct = Number(policy.warning_regression_pct || 25);
  const hardPct = Number(policy.hard_regression_pct || 50);
  let state = 'stable';
  if (delta < -minimum) state = 'improved';
  if (delta > minimum && deltaPct !== null && deltaPct >= warningPct) state = 'regressed';
  if (delta > minimum && deltaPct !== null && deltaPct >= hardPct) state = 'hard_regression';
  return {
    metric,
    current,
    baseline,
    delta,
    delta_pct: deltaPct === null ? null : Math.round(deltaPct * 10) / 10,
    state,
  };
}

function candidateFrom(cache, load) {
  const api = {};
  for (const item of cache.measurements || []) {
    api[item.key] = {
      endpoint: item.endpoint,
      cold_build_ms: Number(item.cold?.build_ms),
      cold_request_ms: Number(item.cold?.request_ms),
      warm_request_ms: Number(item.warm?.request_ms),
      payload_bytes: Number(item.payload_bytes),
      ttl_seconds: Number(item.cold?.ttl_seconds),
    };
  }

  const pages = {};
  for (const item of load.results || []) {
    if (!item.cold || !item.revisit) continue;
    pages[item.key] = {
      url: item.url,
      cold_data_ready_ms: Number(item.cold.data_ready_ms),
      revisit_data_ready_ms: Number(item.revisit.data_ready_ms),
      cold_api_requests: Number(item.cold.api_request_count),
      revisit_api_requests: Number(item.revisit.api_request_count),
      cold_transfer_bytes: Number(item.cold.html_transfer_bytes || 0) + Number(item.cold.resource_transfer_bytes || 0),
      revisit_transfer_bytes:
        Number(item.revisit.html_transfer_bytes || 0) + Number(item.revisit.resource_transfer_bytes || 0),
    };
  }

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    api,
    pages,
  };
}

function comparisonsForSection(section, current, baseline, policy, metrics) {
  const rows = [];
  for (const [key, currentItem] of Object.entries(current || {})) {
    const baselineItem = baseline?.[key];
    if (!baselineItem) continue;
    for (const metric of metrics) {
      rows.push({ section, key, ...compareMetric(metric, Number(currentItem[metric]), Number(baselineItem[metric]), policy) });
    }
  }
  return rows;
}

function formatMs(value) {
  return Number.isFinite(value) ? `${Math.round(value)} ms` : '—';
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return '—';
  if (value < 1024) return `${Math.round(value)} B`;
  return `${(value / 1024).toFixed(1)} KB`;
}

function markdown(candidate, baseline, comparisons, status) {
  const lines = [
    '# Performance baseline',
    '',
    `Status: **${status}**`,
    '',
  ];
  if (!baseline.accepted_from_commit) {
    lines.push(
      'No production baseline has been accepted yet. This deployment is a candidate sample; timing regression gates remain disabled while normal variance is established.',
      '',
    );
  } else {
    lines.push(`Accepted baseline: \`${baseline.accepted_from_commit}\` (${baseline.accepted_at || 'date not recorded'})`, '');
  }

  lines.push('| API | Cold build | Warm request | Payload |', '| --- | ---: | ---: | ---: |');
  for (const [key, item] of Object.entries(candidate.api)) {
    lines.push(`| ${key} | ${formatMs(item.cold_build_ms)} | ${formatMs(item.warm_request_ms)} | ${formatBytes(item.payload_bytes)} |`);
  }
  lines.push('', '| Page | Cold data-ready | Revisit data-ready | Revisit API requests |', '| --- | ---: | ---: | ---: |');
  for (const [key, item] of Object.entries(candidate.pages)) {
    lines.push(`| ${key} | ${formatMs(item.cold_data_ready_ms)} | ${formatMs(item.revisit_data_ready_ms)} | ${item.revisit_api_requests} |`);
  }

  if (comparisons.length) {
    const regressions = comparisons.filter((item) => ['regressed', 'hard_regression'].includes(item.state));
    lines.push('', `Comparisons: ${comparisons.length} metrics · ${regressions.length} regressions outside the noise floor.`);
    for (const item of regressions.slice(0, 12)) {
      lines.push(`- ${item.section}/${item.key} ${item.metric}: ${item.baseline} → ${item.current} (${item.delta_pct >= 0 ? '+' : ''}${item.delta_pct}%)`);
    }
  }
  return `${lines.join('\n')}\n`;
}

try {
  const [cache, load, baseline] = await Promise.all([
    readJson(path.join(outDir, 'cache-performance-summary.json')),
    readJson(path.join(outDir, 'load-time-summary.json')),
    readJson(baselinePath),
  ]);
  if (!cache.ok) throw new Error('cache-performance measurement is not valid');
  if (!load.ok) throw new Error('load-time measurement is not valid');

  const candidate = candidateFrom(cache, load);
  const policy = baseline.threshold_policy || {};
  const hasBaseline = Boolean(
    baseline.accepted_from_commit &&
      (Object.keys(baseline.api || {}).length || Object.keys(baseline.pages || {}).length),
  );
  const comparisons = hasBaseline
    ? [
        ...comparisonsForSection('api', candidate.api, baseline.api, policy, [
          'cold_build_ms',
          'cold_request_ms',
          'warm_request_ms',
          'payload_bytes',
        ]),
        ...comparisonsForSection('page', candidate.pages, baseline.pages, policy, [
          'cold_data_ready_ms',
          'revisit_data_ready_ms',
          'revisit_api_requests',
          'revisit_transfer_bytes',
        ]),
      ]
    : [];

  const hardRegressions = comparisons.filter((item) => item.state === 'hard_regression');
  const regressions = comparisons.filter((item) => item.state === 'regressed');
  const improved = comparisons.filter((item) => item.state === 'improved');
  const comparisonOnly = policy.comparison_only !== false;
  const status = !hasBaseline
    ? 'COLLECTING'
    : hardRegressions.length
      ? 'REGRESSED'
      : regressions.length
        ? 'WATCH'
        : 'PASS';

  const results = comparisons.map((item) => ({
    name: `${item.section}/${item.key}/${item.metric}`,
    ok: !['regressed', 'hard_regression'].includes(item.state),
    state: item.state,
    current: item.current,
    baseline: item.baseline,
    delta: item.delta,
    delta_pct: item.delta_pct,
  }));

  const summary = {
    ok: comparisonOnly || hardRegressions.length === 0,
    status,
    measured_at: candidate.generated_at,
    accepted_baseline_commit: baseline.accepted_from_commit,
    comparison_only: comparisonOnly,
    counts: {
      compared: comparisons.length,
      improved: improved.length,
      regressed: regressions.length,
      hard_regressions: hardRegressions.length,
    },
    results,
  };

  await fs.writeFile(path.join(outDir, 'performance-candidate-baseline.json'), JSON.stringify(candidate, null, 2));
  await fs.writeFile(path.join(outDir, 'performance-baseline-summary.json'), JSON.stringify(summary, null, 2));
  await fs.writeFile(path.join(outDir, 'performance-baseline-report.md'), markdown(candidate, baseline, comparisons, status));
  console.log(JSON.stringify(summary));
  if (!summary.ok) process.exitCode = 1;
} catch (error) {
  const summary = { ok: false, status: 'FAIL', error: error.message };
  await fs.writeFile(path.join(outDir, 'performance-baseline-summary.json'), JSON.stringify(summary, null, 2));
  console.error(error);
  process.exitCode = 1;
}
