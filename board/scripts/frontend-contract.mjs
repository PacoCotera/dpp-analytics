import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const staticRoot = join(root, 'static');
const pages = readdirSync(staticRoot)
  .filter((name) => name.endsWith('.html'))
  .sort();

const pageStyles = {
  'ads.html': 'ads.css',
  'catalog.html': 'catalog.css',
  'data_health.html': 'data-health.css',
  'finance.html': 'finance.css',
  'home.html': 'home.css',
  'inventory.html': 'inventory.css',
  'product.html': 'product.css',
  'sales.html': 'sales.css',
  'today.html': 'today.css',
  'trajectory.html': 'trajectory.css',
};
const sharedStyles = ['theme.css', 'design-refine.css', 'nav-shell.css', 'layout-system.css'];
const failures = [];

function check(condition, page, message) {
  if (!condition) failures.push(`${page}: ${message}`);
}

for (const page of pages) {
  const html = readFileSync(join(staticRoot, page), 'utf8');
  const css = [...html.matchAll(/<link\b[^>]*href=["']([^"']+\.css(?:\?[^"']*)?)["'][^>]*>/gi)].map((match) =>
    basename(match[1].split('?')[0]),
  );
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];

  check(page in pageStyles, page, 'page stylesheet is not declared in the frontend contract');
  check(!/mobile-ux\.css/i.test(html), page, 'deprecated mobile compatibility shim is loaded');
  check(!/<style\b/i.test(html) && !/\sstyle\s*=/i.test(html), page, 'contains inline CSS');
  check(
    !/\/assets\/[^"'?#]+\.(?:css|js)\?[^"']+/i.test(html),
    page,
    'uses manual asset versioning instead of the server asset generation',
  );

  let previous = -1;
  for (const shared of sharedStyles) {
    const index = css.indexOf(shared);
    check(index >= 0, page, `missing shared stylesheet ${shared}`);
    check(css.filter((name) => name === shared).length === 1, page, `loads ${shared} more than once`);
    check(index > previous, page, `${shared} is outside the canonical shared-layer order`);
    previous = index;
  }

  const pageStyle = pageStyles[page];
  const pageStyleIndex = css.indexOf(pageStyle);
  check(pageStyleIndex > previous, page, `${pageStyle} must load after shared layout layers`);
  const chartIndex = css.indexOf('chart-system.css');
  check(
    chartIndex < 0 || (chartIndex > previous && chartIndex < pageStyleIndex),
    page,
    'chart-system.css is outside its owned layer',
  );

  check(
    scripts.every((match) => /\bsrc=["'][^"']+["']/i.test(match[1])),
    page,
    'contains inline JavaScript',
  );
  const shellScripts = scripts.filter((match) => /\/assets\/ui-shell\.js(?:\?[^"']*)?/i.test(match[1]));
  check(shellScripts.length === 1, page, 'must load ui-shell.js exactly once');
  check(
    shellScripts.length === 1 && /\bdefer\b/i.test(shellScripts[0][1]),
    page,
    'ui-shell.js must be deferred',
  );

  const footers = html.match(/<footer\b[^>]*class=["'][^"']*\bfooter\b[^"']*["'][^>]*>/gi) || [];
  check(footers.length === 1, page, 'must contain exactly one shared footer');
  check((html.match(/__DPP_BUILD_SHA__/g) || []).length === 1, page, 'must contain exactly one build token');
}

for (const expected of Object.keys(pageStyles)) {
  check(pages.includes(expected), expected, 'declared page is missing from static');
}

if (failures.length) {
  console.error(`Frontend contract failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
  process.exit(1);
}

console.log(`Frontend contract: ${pages.length} pages share one ordered shell/layout contract.`);
