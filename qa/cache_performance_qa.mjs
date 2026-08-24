import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const baseUrl = (process.argv[2] || 'http://127.0.0.1:8088').replace(/\/$/, '');
const outDir = process.argv[3] || '/out';
await fs.mkdir(outDir, { recursive: true });

const ENDPOINTS = [
  { key: 'today', endpoint: '/api/today' },
  { key: 'business', endpoint: '/api/home' },
  { key: 'sales', endpoint: '/api/sales' },
  { key: 'sales_geography', endpoint: '/api/sales/geography' },
  { key: 'catalog', endpoint: '/api/catalog' },
  { key: 'inventory', endpoint: '/api/inventory' },
  { key: 'finance', endpoint: '/api/finance' },
  { key: 'ads', endpoint: '/api/ads' },
  { key: 'product', endpoint: '/api/product?sku=PNC-001' },
  { key: 'trajectory', endpoint: '/api/trajectory' },
  { key: 'data_health', endpoint: '/api/data-health' },
];

async function probe(endpoint) {
  const coldUrl = new URL(endpoint, `${baseUrl}/`);
  coldUrl.searchParams.set('refresh', '1');

  const coldStarted = performance.now();
  const coldResponse = await fetch(coldUrl, { cache: 'no-store' });
  const coldBody = await coldResponse.text();
  const coldElapsedMs = Math.round(performance.now() - coldStarted);
  if (!coldResponse.ok) {
    throw new Error(
      `${endpoint} cold probe returned ${coldResponse.status}: ${coldBody.slice(0, 200)}`,
    );
  }

  const warmStarted = performance.now();
  const warmResponse = await fetch(new URL(endpoint, `${baseUrl}/`), { cache: 'no-store' });
  const warmBody = await warmResponse.text();
  const warmElapsedMs = Math.round(performance.now() - warmStarted);
  if (!warmResponse.ok) {
    throw new Error(
      `${endpoint} warm probe returned ${warmResponse.status}: ${warmBody.slice(0, 200)}`,
    );
  }

  const coldCache = coldResponse.headers.get('x-dpp-cache');
  const warmCache = warmResponse.headers.get('x-dpp-cache');
  const coldBuildMs = Number(coldResponse.headers.get('x-dpp-build-ms'));
  const warmBuildMs = Number(warmResponse.headers.get('x-dpp-build-ms'));
  if (coldCache !== 'REFRESH') {
    throw new Error(`${endpoint} cold probe expected REFRESH, got ${coldCache}`);
  }
  if (warmCache !== 'HIT') throw new Error(`${endpoint} warm probe expected HIT, got ${warmCache}`);
  if (!Number.isFinite(coldBuildMs) || coldBuildMs < 0) {
    throw new Error(`${endpoint} cold build timing missing`);
  }
  if (warmBuildMs !== 0) {
    throw new Error(`${endpoint} warm cache hit reported ${warmBuildMs}ms build work`);
  }
  if (coldBody !== warmBody) {
    throw new Error(`${endpoint} warm payload differs from the forced cold payload`);
  }

  return {
    endpoint,
    payload_bytes: Buffer.byteLength(coldBody),
    cold: {
      cache: coldCache,
      build_ms: coldBuildMs,
      request_ms: coldElapsedMs,
      ttl_seconds: Number(coldResponse.headers.get('x-dpp-cache-ttl')),
    },
    warm: {
      cache: warmCache,
      build_ms: warmBuildMs,
      request_ms: warmElapsedMs,
      age_seconds: Number(warmResponse.headers.get('x-dpp-cache-age')),
    },
    payload: JSON.parse(coldBody),
  };
}

function publicMeasurement(key, measurement) {
  return {
    key,
    endpoint: measurement.endpoint,
    payload_bytes: measurement.payload_bytes,
    cold: measurement.cold,
    warm: measurement.warm,
  };
}

try {
  const measured = {};
  for (const definition of ENDPOINTS) {
    measured[definition.key] = await probe(definition.endpoint);
  }

  if ('geography' in measured.sales.payload) {
    throw new Error('Default Sales payload still contains geography');
  }
  if (!measured.sales_geography.payload?.geography) {
    throw new Error('Lazy Sales geography payload is missing geography');
  }

  const measurements = ENDPOINTS.map(({ key }) => publicMeasurement(key, measured[key]));
  const cold_build_ranking = [...measurements].sort(
    (left, right) => right.cold.build_ms - left.cold.build_ms,
  );
  const payload_size_ranking = [...measurements].sort(
    (left, right) => right.payload_bytes - left.payload_bytes,
  );
  const warm_request_ranking = [...measurements].sort(
    (left, right) => right.warm.request_ms - left.warm.request_ms,
  );

  const summary = {
    ok: true,
    measured_at: new Date().toISOString(),
    measurements,
    cold_build_ranking,
    payload_size_ranking,
    warm_request_ranking,
    totals: {
      payload_bytes: measurements.reduce((sum, item) => sum + item.payload_bytes, 0),
      cold_build_ms: measurements.reduce((sum, item) => sum + item.cold.build_ms, 0),
    },
  };

  await fs.writeFile(
    path.join(outDir, 'cache-performance-summary.json'),
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify(summary));
} catch (error) {
  const summary = { ok: false, error: error.message };
  await fs.writeFile(
    path.join(outDir, 'cache-performance-summary.json'),
    JSON.stringify(summary, null, 2),
  );
  console.error(error);
  process.exit(1);
}
