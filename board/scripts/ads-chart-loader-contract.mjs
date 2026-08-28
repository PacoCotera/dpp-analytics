import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { adsChartAssetUrls } from '../static/ads-chart-loader.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const page = readFileSync(join(root, 'static', 'ads.html'), 'utf8');

assert.doesNotMatch(page, /<script[^>]+(?:d3\.v7\.min|chart-system)\.js/);
assert.doesNotMatch(page, /<link[^>]+chart-system\.css/);

assert.deepEqual(adsChartAssetUrls('https://example.test/assets/ads-chart-loader.js?v=abc123'), {
  stylesheet: 'https://example.test/assets/chart-system.css?v=abc123',
  d3: 'https://example.test/assets/vendor/d3.v7.min.js?v=abc123',
  runtime: 'https://example.test/assets/chart-system.js?v=abc123',
});
assert.deepEqual(adsChartAssetUrls('https://example.test/assets/ads-chart-loader.js'), {
  stylesheet: 'https://example.test/assets/chart-system.css',
  d3: 'https://example.test/assets/vendor/d3.v7.min.js',
  runtime: 'https://example.test/assets/chart-system.js',
});

console.log('Ads chart loader contract: empty HTML is lean and dynamic assets preserve release revision.');
