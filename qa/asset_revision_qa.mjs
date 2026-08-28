import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const baseUrl = (process.argv[2] || 'http://127.0.0.1:8088').replace(/\/$/, '');
const outDir = process.argv[3] || '/out';
await fs.mkdir(outDir, { recursive: true });

const routes = [
  '/',
  '/today',
  '/sales',
  '/catalog',
  '/inventory',
  '/finance',
  '/trajectory',
  '/ads',
  '/data-health',
  '/admin',
  '/product?sku=PNC-001',
];

const browser = await chromium.launch({ headless: true });
const results = [];
const failures = [];
const revisions = new Set();
const loadedPaths = new Set();

try {
  for (const route of routes) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const assetResponses = [];
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.origin !== baseUrl || !url.pathname.startsWith('/assets/')) return;
      assetResponses.push({
        url: response.url(),
        status: response.status(),
        cacheControl: response.headers()['cache-control'] || '',
        etag: response.headers().etag || '',
        revision: response.headers()['x-dpp-asset-revision'] || '',
      });
    });

    const navigation = await page.goto(`${baseUrl}${route}`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    if (!navigation?.ok()) throw new Error(`${route}: navigation ${navigation?.status() || 'failed'}`);
    await page.waitForTimeout(600);
    if (route === '/sales') {
      await page.locator('button[data-view="geography"]').click();
      await page.locator('#geoMap path.state-shape').first().waitFor({ state: 'visible', timeout: 15000 });
    }

    const pageContract = await page.evaluate(() => ({
      revision: document.querySelector('meta[name="dpp-asset-revision"]')?.getAttribute('content') || '',
      assets: performance
        .getEntriesByType('resource')
        .map(entry => entry.name)
        .filter(url => new URL(url).origin === location.origin && new URL(url).pathname.startsWith('/assets/')),
    }));
    const headerRevision = navigation.headers()['x-dpp-asset-revision'] || '';
    if (!/^[0-9a-f]{12}$/.test(pageContract.revision)) {
      failures.push(`${route}: invalid page asset revision ${JSON.stringify(pageContract.revision)}`);
    }
    if (headerRevision !== pageContract.revision) {
      failures.push(`${route}: HTML header revision ${headerRevision} != meta ${pageContract.revision}`);
    }
    revisions.add(pageContract.revision);

    for (const rawUrl of pageContract.assets) {
      const url = new URL(rawUrl);
      loadedPaths.add(url.pathname);
      if (url.searchParams.get('v') !== pageContract.revision) {
        failures.push(`${route}: mixed or unversioned asset ${url.pathname}${url.search}`);
      }
    }
    for (const response of assetResponses) {
      const url = new URL(response.url);
      if (url.searchParams.get('v') !== pageContract.revision) continue;
      if (response.status !== 200) failures.push(`${route}: ${url.pathname} returned ${response.status}`);
      if (!/max-age=31536000/.test(response.cacheControl) || !/immutable/.test(response.cacheControl)) {
        failures.push(`${route}: ${url.pathname} is not immutable (${response.cacheControl})`);
      }
      if (!response.etag || response.revision !== pageContract.revision) {
        failures.push(`${route}: ${url.pathname} has incomplete release headers`);
      }
    }
    results.push({
      route,
      revision: pageContract.revision,
      assetCount: pageContract.assets.length,
      assetPaths: [...new Set(pageContract.assets.map(url => new URL(url).pathname))].sort(),
    });
    await context.close();
  }

  if (revisions.size !== 1) failures.push(`Pages disagree on asset revision: ${[...revisions].join(', ')}`);
  const [revision] = revisions;
  const manifestResponse = await fetch(`${baseUrl}/assets/manifest.json?v=${revision}`);
  const manifest = await manifestResponse.json();
  if (manifestResponse.status !== 200 || manifest.revision !== revision) {
    failures.push(`Release manifest mismatch: ${manifestResponse.status} / ${manifest.revision}`);
  }
  if (!/max-age=31536000/.test(manifestResponse.headers.get('cache-control') || '')) {
    failures.push('Versioned release manifest is not immutable');
  }
  for (const assetPath of loadedPaths) {
    const manifestAsset = manifest.assets?.[assetPath];
    if (!manifestAsset) failures.push(`Loaded asset is absent from release manifest: ${assetPath}`);
    if (manifestAsset?.url !== `${assetPath}?v=${revision}`) {
      failures.push(`Manifest URL mismatch for ${assetPath}: ${manifestAsset?.url || 'missing'}`);
    }
  }

  const stablePage = await fetch(`${baseUrl}/sales`, { cache: 'no-store' });
  const stablePageEtag = stablePage.headers.get('etag') || '';
  const conditionalPage = await fetch(`${baseUrl}/sales`, {
    headers: { 'If-None-Match': stablePageEtag },
  });
  if (
    stablePage.status !== 200 ||
    !stablePageEtag ||
    stablePage.headers.get('x-dpp-asset-revision') !== revision ||
    conditionalPage.status !== 304
  ) {
    failures.push(`Stable page validator returned ${stablePage.status}/${conditionalPage.status}`);
  }

  const stable = await fetch(`${baseUrl}/assets/ui-utils.js`, { cache: 'no-store' });
  const stableBody = await stable.text();
  const stableEtag = stable.headers.get('etag') || '';
  if (
    stable.status !== 200 ||
    !stableEtag ||
    !/max-age=0/.test(stable.headers.get('cache-control') || '') ||
    !/must-revalidate/.test(stable.headers.get('cache-control') || '') ||
    stable.headers.get('x-dpp-asset-revision') !== revision
  ) {
    failures.push('Stable asset URL has no revalidation contract');
  }
  if (!stableBody.includes(`./data-cache.js?v=${revision}`)) {
    failures.push('Stable module response does not bind its transitive import to the current release');
  }
  const conditional = await fetch(`${baseUrl}/assets/ui-utils.js`, {
    headers: { 'If-None-Match': stableEtag },
  });
  if (conditional.status !== 304 || conditional.headers.get('etag') !== stableEtag) {
    failures.push(`Stable ETag validator returned ${conditional.status}`);
  }

  const mismatch = await fetch(`${baseUrl}/assets/ui-utils.js?v=000000000000`);
  if (mismatch.status !== 409 || mismatch.headers.get('cache-control') !== 'no-store') {
    failures.push(`Mismatched asset revision returned ${mismatch.status}`);
  }

  const summary = {
    ok: failures.length === 0,
    revision,
    manifestAssets: Object.keys(manifest.assets || {}).length,
    loadedAssets: loadedPaths.size,
    stable: {
      status: stable.status,
      cacheControl: stable.headers.get('cache-control'),
      etag: stableEtag,
      conditionalStatus: conditional.status,
      pageEtag: stablePageEtag,
      conditionalPageStatus: conditionalPage.status,
    },
    mismatchStatus: mismatch.status,
    results,
    failures,
  };
  await fs.writeFile(path.join(outDir, 'asset-revision-summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
  if (failures.length) process.exitCode = 1;
} catch (error) {
  const summary = { ok: false, error: error.message, failures };
  await fs.writeFile(path.join(outDir, 'asset-revision-summary.json'), JSON.stringify(summary, null, 2));
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
