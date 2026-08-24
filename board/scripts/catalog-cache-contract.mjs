import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const owners = ['catalog.js', 'catalog-ads-context.js'];
const failures = [];

for (const owner of owners) {
  const source = readFileSync(join(root, 'static', owner), 'utf8');
  if (/\bfetch\s*\(\s*['"`]\/api\/catalog(?:[?'"`])/m.test(source)) {
    failures.push(`${owner}: bypasses shared fetchJson browser cache for /api/catalog`);
  }
  if (!/\bfetchJson\s*\(\s*['"`]\/api\/catalog(?:[?'"`])/m.test(source)) {
    failures.push(`${owner}: does not consume /api/catalog through shared fetchJson`);
  }
}

if (failures.length) {
  console.error(`Catalog cache contract failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
  process.exit(1);
}

console.log('Catalog cache contract: both consumers share the browser cache owner.');
