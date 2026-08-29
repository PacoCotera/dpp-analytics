import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const owner = 'catalog.js';
const failures = [];

const source = readFileSync(join(root, 'static', owner), 'utf8');
const catalogHtml = readFileSync(join(root, 'static', 'catalog.html'), 'utf8');
const productHtml = readFileSync(join(root, 'static', 'product.html'), 'utf8');
if (/\bfetch\s*\(\s*['"`]\/api\/catalog(?:[?'"`])/m.test(source)) {
  failures.push(`${owner}: bypasses shared fetchJson browser cache for /api/catalog`);
}
if ((source.match(/\bfetchJson\s*\(\s*['"`]\/api\/catalog(?:[?'"`])/gm) || []).length !== 1) {
  failures.push(`${owner}: must own exactly one /api/catalog request through shared fetchJson`);
}
if (/MutationObserver/.test(source)) {
  failures.push(`${owner}: must render Ads context directly rather than post-render observation`);
}
if (existsSync(join(root, 'static', 'catalog-ads-context.js'))) {
  failures.push('catalog-ads-context.js: superseded second renderer still exists');
}
if (/metric-basis-ui\.js/.test(catalogHtml)) {
  failures.push('catalog.html: metric-basis-ui.js remains a second post-render owner');
}
if (/metric-basis-ui\.js/.test(productHtml)) {
  failures.push('product.html: metric-basis-ui.js remains a second post-render owner');
}
if (
  source.includes('<a class="child"') ||
  !source.includes('<div class="analysis-row">\n    <a class="analysis-identity analysis-link"') ||
  !source.includes('</summary>\n    ${familyRule ?')
) {
  failures.push(`${owner}: rule disclosure must render beside, not inside, row links and summaries`);
}

if (failures.length) {
  console.error(`Catalog cache contract failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
  process.exit(1);
}

console.log('Catalog cache contract: catalog.js is the single API and render owner.');
