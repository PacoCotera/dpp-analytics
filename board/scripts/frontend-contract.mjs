import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXPECTED_PROFILE_IDS } from './presentation-contract.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const staticRoot = join(root, 'static');
const pages = readdirSync(staticRoot)
  .filter((name) => name.endsWith('.html'))
  .sort();

const pageStyles = {
  'admin.html': 'admin.css',
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
const sharedStyles = ['theme.css', 'nav-shell.css', 'layout-system.css'];
const presentationAssets = [
  'presentation-registry.js',
  'presentation.js',
  'theme.css',
  'nav-shell.css',
  'layout-system.css',
  'presentation-profiles.css',
  'ui-shell.js',
];
const failures = [];
const theme = readFileSync(join(staticRoot, 'theme.css'), 'utf8');
const layout = readFileSync(join(staticRoot, 'layout-system.css'), 'utf8');
const presentationRuntime = readFileSync(join(staticRoot, 'presentation.js'), 'utf8');
const presentationCss = readFileSync(join(staticRoot, 'presentation-profiles.css'), 'utf8');
const presentationRegistry = JSON.parse(
  readFileSync(join(root, 'presentation', 'profiles.json'), 'utf8'),
);
const todayHtml = readFileSync(join(staticRoot, 'today.html'), 'utf8');
const todayScript = readFileSync(join(staticRoot, 'today.js'), 'utf8');
const shellSelector =
  /\.(?:app|topbar|brand|brand-copy|brand-title|brand-sub|mark|top-meta|primary-nav|nav-more|footer)\b/;
const retiredComponentNames = new Set([
  'card',
  'card-pad',
  'metric',
  'metric-label',
  'metric-value',
  'metric-note',
  'table-wrap',
  'table',
  'page-head',
  'page-summary',
  'page-actions',
  'view-tabs',
  'view-tab',
  'story',
  'story-side',
  'story-caption',
  'story-link',
  'section',
  'section-head',
  'section-title',
  'section-sub',
  'section-link',
  'grid',
]);
const retiredComponentSelector = new RegExp(`\\.(?:${[...retiredComponentNames].join('|')})(?![\\w-])`);
const pageOwnedOrRetiredThemeSelector =
  /\.story-number(?![\w-])|\.chip\.dark(?![\w-])|\.(?:mini-bars|pc-image|product-win|product-card|product-identity|product-image)(?![\w-])/;

function check(condition, page, message) {
  if (!condition) failures.push(`${page}: ${message}`);
}

for (const page of pages) {
  const html = readFileSync(join(staticRoot, page), 'utf8');
  const css = [...html.matchAll(/<link\b[^>]*href=["']([^"']+\.css(?:\?[^"']*)?)["'][^>]*>/gi)].map((match) =>
    basename(match[1].split('?')[0]),
  );
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  const localAssets = [
    ...html.matchAll(
      /<(script|link)\b[^>]*(?:src|href)=["'](\/assets\/[^"']+)["'][^>]*>/gi,
    ),
  ].map((match) => ({
    tag: match[1].toLowerCase(),
    name: basename(match[2].split('?')[0]),
    markup: match[0],
    index: match.index,
  }));
  const classNames = [...html.matchAll(/\bclass=["']([^"']*)["']/gi)].flatMap((match) =>
    match[1].trim().split(/\s+/),
  );
  const qaMarkers = [...html.matchAll(/\bdata-dpp-qa=["']([^"']+)["']/gi)].map(
    (match) => match[1],
  );

  check(page in pageStyles, page, 'page stylesheet is not declared in the frontend contract');
  check(
    qaMarkers.every((marker) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(marker)),
    page,
    'data-dpp-qa markers must use stable lowercase kebab-case names',
  );
  check(
    new Set(qaMarkers).size === qaMarkers.length,
    page,
    'data-dpp-qa markers must be unique within a workspace',
  );
  check(
    !/<meta\b[^>]*\bname=["']theme-color["'][^>]*>/i.test(html),
    page,
    'must not hardcode theme-color; presentation.js owns browser chrome',
  );
  check(!/mobile-ux\.css/i.test(html), page, 'deprecated mobile compatibility shim is loaded');
  check(!/design-refine\.css/i.test(html), page, 'deprecated shared refinement layer is loaded');
  check(!/<style\b/i.test(html) && !/\sstyle\s*=/i.test(html), page, 'contains inline CSS');
  check(
    classNames.every((name) => !retiredComponentNames.has(name)),
    page,
    'uses a retired shared component class',
  );
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

  let presentationAssetIndex = -1;
  for (const asset of presentationAssets) {
    const matches = localAssets.filter(({ name }) => name === asset);
    check(matches.length === 1, page, `must load ${asset} exactly once`);
    if (matches.length === 1) {
      check(
        matches[0].index > presentationAssetIndex,
        page,
        `${asset} is outside the canonical presentation asset order`,
      );
      presentationAssetIndex = matches[0].index;
    }
  }

  const registryScript = localAssets.find(({ name }) => name === 'presentation-registry.js');
  const runtimeScript = localAssets.find(({ name }) => name === 'presentation.js');
  check(
    registryScript?.tag === 'script' &&
      !/\b(?:async|defer)\b/i.test(registryScript.markup) &&
      runtimeScript?.tag === 'script' &&
      !/\b(?:async|defer)\b/i.test(runtimeScript.markup),
    page,
    'presentation registry and runtime must run synchronously before styles paint',
  );

  const pageStyle = pageStyles[page];
  const pageStyleIndex = css.indexOf(pageStyle);
  check(pageStyleIndex > previous, page, `${pageStyle} must load after shared layout layers`);
  const presentationStyleIndex = css.indexOf('presentation-profiles.css');
  check(
    presentationStyleIndex > pageStyleIndex && presentationStyleIndex === css.length - 1,
    page,
    'presentation-profiles.css must be the final stylesheet',
  );
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

check(pages.length === 11, 'static', `expected exactly 11 HTML workspaces; found ${pages.length}`);
check(
  JSON.stringify(pages) === JSON.stringify(Object.keys(pageStyles).sort()),
  'static',
  'served HTML workspaces differ from the declared presentation contract',
);

for (const expected of Object.keys(pageStyles)) {
  check(pages.includes(expected), expected, 'declared page is missing from static');
}

const registryProfileIds = presentationRegistry.profiles.map(({ id }) => id);
check(
  presentationRegistry.profiles.length === 6 &&
    JSON.stringify(registryProfileIds) === JSON.stringify(EXPECTED_PROFILE_IDS),
  'presentation',
  'must contain exactly the six approved presentation profiles in canonical order',
);
const cssProfileIds = [
  ...new Set(
    [...presentationCss.matchAll(/:root\[data-dpp-theme=["']([^"']+)["']\]/g)].map(
      (match) => match[1],
    ),
  ),
];
check(
  JSON.stringify(cssProfileIds) === JSON.stringify(EXPECTED_PROFILE_IDS),
  'presentation-profiles.css',
  'generated CSS must expose exactly one asset scope for each approved profile',
);
for (const marker of [
  'data-dpp-theme',
  'dppPresentation',
  'setProfile',
  'reset',
  "meta[name='theme-color']",
]) {
  check(
    presentationRuntime.includes(marker),
    'presentation.js',
    `presentation runtime is missing required behavior marker: ${marker}`,
  );
}

check(
  !readdirSync(staticRoot).includes('design-refine.css'),
  'static',
  'deprecated refinement layer still exists',
);
check(
  !readdirSync(staticRoot).includes('today-operations.js'),
  'today.html',
  'Today must have one renderer and data owner',
);
check(
  (todayHtml.match(/<script\b[^>]*\btype=["']module["'][^>]*>/gi) || []).length === 1,
  'today.html',
  'Today must load exactly one page module',
);
check(
  (todayScript.match(/fetchJson\(`\/api\/today/g) || []).length === 1,
  'today.js',
  'Today must have exactly one API fetch owner',
);
check(
  (todayScript.match(/setInterval\(load, 20000\)/g) || []).length === 1,
  'today.js',
  'Today must have exactly one live refresh loop',
);
check(!/MutationObserver/.test(todayScript), 'today.js', 'Today must not use post-render correction observers');
check(!shellSelector.test(theme), 'theme.css', 'application-shell rules belong to nav-shell.css');
check(!shellSelector.test(layout), 'layout-system.css', 'application-shell rules belong to nav-shell.css');
check(!retiredComponentSelector.test(theme), 'theme.css', 'retired component rules remain in the theme');
check(
  !pageOwnedOrRetiredThemeSelector.test(theme),
  'theme.css',
  'page-owned or retired rules remain in the shared theme',
);

if (failures.length) {
  console.error(`Frontend contract failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
  process.exit(1);
}

console.log(`Frontend contract: ${pages.length} pages share one ordered shell/layout contract.`);
