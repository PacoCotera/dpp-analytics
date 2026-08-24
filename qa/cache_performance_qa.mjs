import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const baseUrl = (process.argv[2] || 'http://127.0.0.1:8088').replace(/\/$/, '');
const outDir = process.argv[3] || '/out';
await fs.mkdir(outDir, { recursive: true });

async function probe(endpoint) {
  const coldUrl = new URL(endpoint, `${baseUrl}/`);
  coldUrl.searchParams.set('refresh', '1');

  const coldStarted = performance.now();
  const coldResponse = await fetch(coldUrl, { cache: 'no-store' });
  const coldBody = await coldResponse.text();
  const coldElapsedMs = Math.round(performance.now() - coldStarted);
  if (!coldResponse.ok) throw new Error(`${endpoint} cold probe returned ${coldResponse.status}: ${coldBody.slice(0, 200)}`);

  const warmStarted = performance.now();
  const warmResponse = await fetch(new URL(endpoint, `${baseUrl}/`), { cache: 'no-store' });
  const warmBody = await warmResponse.text();
  const warmElapsedMs = Math.round(performance.now() - warmStarted);
  if (!warmResponse.ok) throw new Error(`${endpoint} warm probe returned ${warmResponse.status}: ${warmBody.slice(0, 200)}`);

  const coldCache = coldResponse.headers.get('x-dpp-cache');
  const warmCache = warmResponse.headers.get('x-dpp-cache');
  const coldBuildMs = Number(coldResponse.headers.get('x-dpp-build-ms'));
  const warmBuildMs = Number(warmResponse.headers.get('x-dpp-build-ms'));
  if (coldCache !== 'REFRESH') throw new Error(`${endpoint} cold probe expected REFRESH, got ${coldCache}`);
  if (warmCache !== 'HIT') throw new Error(`${endpoint} warm probe expected HIT, got ${warmCache}`);
  if (!Number.isFinite(coldBuildMs) || coldBuildMs < 0) throw new Error(`${endpoint} cold build timing missing`);
  if (warmBuildMs !== 0) throw new Error(`${endpoint} warm cache hit reported ${warmBuildMs}ms build work`);
  if (coldBody !== warmBody) throw new Error(`${endpoint} warm payload differs from the forced cold payload`);

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

try {
  const sales = await probe('/api/sales');
  const geography = await probe('/api/sales/geography');

  if ('geography' in sales.payload) throw new Error('Default Sales payload still contains geography');
  if (!geography.payload?.geography) throw new Error('Lazy Sales geography payload is missing geography');

  const summary = {
    ok: true,
    measured_at: new Date().toISOString(),
    sales: {
      endpoint: sales.endpoint,
      payload_bytes: sales.payload_bytes,
      cold: sales.cold,
      warm: sales.warm,
    },
    geography: {
      endpoint: geography.endpoint,
      payload_bytes: geography.payload_bytes,
      cold: geography.cold,
      warm: geography.warm,
    },
    combined_payload_bytes: sales.payload_bytes + geography.payload_bytes,
  };

  await fs.writeFile(path.join(outDir, 'cache-performance-summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
} catch (error) {
  const summary = { ok: false, error: error.message };
  await fs.writeFile(path.join(outDir, 'cache-performance-summary.json'), JSON.stringify(summary, null, 2));
  console.error(error);
  process.exit(1);
}
