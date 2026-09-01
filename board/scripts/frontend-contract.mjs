import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import postcss from 'postcss';

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
const routeStyleRoots = {
  'admin.css': 'admin-shell',
  'ads.css': 'ads-page',
  'catalog.css': 'catalog-shell',
  'data-health.css': 'data-health-page',
  'finance.css': 'finance-page',
  'inventory.css': 'inventory-page',
  'product.css': 'product-page',
  'sales.css': 'sales-page',
  'today.css': 'today-app',
  'trajectory.css': 'trajectory-page',
};
const requiredQaMarkers = {
  'admin.html': [
    'admin-workspace',
    'admin-workspace-header',
    'admin-authentication',
    'admin-catalog-editor',
    'admin-product-editors',
  ],
  'ads.html': ['ads-workspace', 'ads-workspace-header', 'ads-overview', 'ads-operating-evidence'],
  'data_health.html': [
    'data-health-workspace',
    'data-health-overview',
    'data-health-summary',
    'data-health-pipeline',
    'catalog-onboarding',
  ],
  'finance.html': [
    'finance-workspace',
    'finance-accounting-header',
    'finance-accounting-overview',
    'finance-current-period',
    'finance-analysis',
    'finance-immutable-history',
    'finance-evidence',
  ],
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
const ownedStyles = new Set([
  ...Object.values(pageStyles),
  ...sharedStyles,
  'chart-system.css',
  'presentation-profiles.css',
  'sales-geography.css',
]);
const failures = [];
const theme = readFileSync(join(staticRoot, 'theme.css'), 'utf8');
const layout = readFileSync(join(staticRoot, 'layout-system.css'), 'utf8');
const presentationRuntime = readFileSync(join(staticRoot, 'presentation.js'), 'utf8');
const presentationCss = readFileSync(join(staticRoot, 'presentation-profiles.css'), 'utf8');
const presentationRegistry = JSON.parse(readFileSync(join(root, 'presentation', 'profiles.json'), 'utf8'));
const todayHtml = readFileSync(join(staticRoot, 'today.html'), 'utf8');
const todayScript = readFileSync(join(staticRoot, 'today.js'), 'utf8');
const homeHtml = readFileSync(join(staticRoot, 'home.html'), 'utf8');
const homeScript = readFileSync(join(staticRoot, 'home.js'), 'utf8');
const homeCss = readFileSync(join(staticRoot, 'home.css'), 'utf8');
const trajectoryHtml = readFileSync(join(staticRoot, 'trajectory.html'), 'utf8');
const trajectoryScript = readFileSync(join(staticRoot, 'trajectory.js'), 'utf8');
const trajectoryCss = readFileSync(join(staticRoot, 'trajectory.css'), 'utf8');
const productHtml = readFileSync(join(staticRoot, 'product.html'), 'utf8');
const catalogHtml = readFileSync(join(staticRoot, 'catalog.html'), 'utf8');
const catalogScript = readFileSync(join(staticRoot, 'catalog.js'), 'utf8');
const inventoryHtml = readFileSync(join(staticRoot, 'inventory.html'), 'utf8');
const salesHtml = readFileSync(join(staticRoot, 'sales.html'), 'utf8');
const financeHtml = readFileSync(join(staticRoot, 'finance.html'), 'utf8');
const financeScript = readFileSync(join(staticRoot, 'finance.js'), 'utf8');
const financeCss = readFileSync(join(staticRoot, 'finance.css'), 'utf8');
const catalogCss = readFileSync(join(staticRoot, 'catalog.css'), 'utf8');
const productCss = readFileSync(join(staticRoot, 'product.css'), 'utf8');
const dataHealthScript = readFileSync(join(staticRoot, 'data-health.js'), 'utf8');
const chartSystem = readFileSync(join(staticRoot, 'chart-system.js'), 'utf8');
const chartCss = readFileSync(join(staticRoot, 'chart-system.css'), 'utf8');
const salesGeographyScript = readFileSync(join(staticRoot, 'sales-geography-v2.js'), 'utf8');
const salesGeographyCss = readFileSync(join(staticRoot, 'sales-geography.css'), 'utf8');
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

const actualStyles = readdirSync(staticRoot)
  .filter((name) => name.endsWith('.css'))
  .sort();
check(
  JSON.stringify(actualStyles) === JSON.stringify([...ownedStyles].sort()),
  'static',
  `stylesheet ownership differs from the declared presentation layers: ${actualStyles.join(', ')}`,
);

for (const stylesheet of actualStyles) {
  const stylesheetAst = postcss.parse(readFileSync(join(staticRoot, stylesheet), 'utf8'), {
    from: stylesheet,
  });
  stylesheetAst.walkRules((rule) => {
    const declarationOwners = new Map();
    rule.walkDecls((declaration) => {
      const property = declaration.prop.toLowerCase();
      check(
        !declarationOwners.has(property),
        stylesheet,
        `${rule.selector} declares ${property} more than once in the same rule`,
      );
      declarationOwners.set(property, declaration.source.start.line);
    });
  });
}

for (const page of pages) {
  const html = readFileSync(join(staticRoot, page), 'utf8');
  const css = [...html.matchAll(/<link\b[^>]*href=["']([^"']+\.css(?:\?[^"']*)?)["'][^>]*>/gi)].map((match) =>
    basename(match[1].split('?')[0]),
  );
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  const localAssets = [
    ...html.matchAll(/<(script|link)\b[^>]*(?:src|href)=["'](\/assets\/[^"']+)["'][^>]*>/gi),
  ].map((match) => ({
    tag: match[1].toLowerCase(),
    name: basename(match[2].split('?')[0]),
    markup: match[0],
    index: match.index,
  }));
  const classNames = [...html.matchAll(/\bclass=["']([^"']*)["']/gi)].flatMap((match) =>
    match[1].trim().split(/\s+/),
  );
  const qaMarkers = [...html.matchAll(/\bdata-dpp-qa=["']([^"']+)["']/gi)].map((match) => match[1]);

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
  for (const marker of requiredQaMarkers[page] || []) {
    check(qaMarkers.includes(marker), page, `missing stable data-dpp-qa marker ${marker}`);
  }
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
    [...presentationCss.matchAll(/:root\[data-dpp-theme=["']([^"']+)["']\]/g)].map((match) => match[1]),
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
  !readdirSync(staticRoot).includes('mobile-ux.css'),
  'static',
  'deprecated mobile compatibility layer still exists',
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
check(
  !/MutationObserver/.test(todayScript),
  'today.js',
  'Today must not use post-render correction observers',
);
check(
  /if \(period === 'ytd'\) return rows;/.test(todayScript),
  'today.js',
  'Today YTD must return the calendar-year payload instead of falling through to 30D',
);
check(
  !/\.home-health\s*\{[^}]*\bpadding\s*:/s.test(homeCss),
  'home.css',
  'Business Health must inherit the shared home-surface inset',
);
check(
  !/#geography\s+/.test(salesGeographyCss),
  'sales-geography.css',
  'Geography layout must not use ID specificity that defeats responsive rules',
);
check(
  /@media \(max-width: 1180px\)\s*\{[\s\S]*?\.geo-grid\s*\{[\s\S]*?grid-template-columns:\s*1fr/s.test(
    salesGeographyCss,
  ),
  'sales-geography.css',
  'Geography must collapse its two-column workspace below 1180px',
);
check(
  /\.geo-kpi-rail\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,/s.test(salesGeographyCss),
  'sales-geography.css',
  'Geography KPIs must reflow to two columns on narrow screens',
);
check(
  !/\.hero-command\s*\{[^}]*display:\s*none/s.test(productCss),
  'product.css',
  'Product Health must remain visible on mobile',
);
check(
  /@media \(max-width:\s*480px\)[\s\S]*?\.family\s*>\s*summary,[\s\S]*?grid-template-columns:\s*repeat\(2,/s.test(
    catalogCss,
  ) && /\.family\s*>\s*summary\s*>\s*\.metric-stock,[\s\S]*?grid-column:\s*1\s*\/\s*3/s.test(catalogCss),
  'catalog.css',
  'Catalog mobile metrics must use a readable two-row grid',
);
check(
  /\.finance-progression\s*\{[^}]*min-height:\s*720px/s.test(financeCss) &&
    /point\._current\s*&&\s*!compact\s*&&\s*!dense/.test(financeScript) &&
    /index\s*===\s*0\s*\|\|\s*\(index\s*%\s*labelStep\s*===\s*0\s*&&\s*index\s*<\s*points\.length\s*-\s*1\)/.test(
      financeScript,
    ) &&
    /const compactNudge\s*=\s*compact\s*\?/.test(financeScript) &&
    /point\.compactLabel\s*\|\|\s*point\.label/.test(financeScript) &&
    /if\s*\(!compact\)\s*\{\s*output\s*\+=\s*`<text class="dpp-muted"[^`]+PENDING<\/text>`/s.test(
      financeScript,
    ) &&
    /totalTop\s*-\s*\(compact\s*\?\s*18\s*:\s*7\)/.test(financeScript),
  'finance.js',
  'Finance mobile windows must keep a stable card and collision-safe chart labels',
);
for (const [page, html] of [
  ['home.html', homeHtml],
  ['today.html', todayHtml],
  ['trajectory.html', trajectoryHtml],
  ['sales.html', salesHtml],
  ['product.html', productHtml],
  ['finance.html', financeHtml],
]) {
  const controls = [...html.matchAll(/<div\b[^>]*\btime-window-control\b[^>]*>[\s\S]*?<\/div>/gi)];
  check(controls.length > 0, page, 'chart time windows must use the shared time-window control');
  check(
    controls.every(([markup]) => />\s*YTD\s*</i.test(markup)),
    page,
    'every chart time-window control must offer YTD',
  );
}
check(
  /DPPCharts\.demandRhythm/.test(homeScript) && /DPPCharts\.demandRhythm/.test(todayScript),
  'chart-system.js',
  'Business and Today demand must share one chart renderer',
);
check(
  /const barOccupancy = data\.length <= 14 \? 0\.5 : data\.length <= 45 \? 0\.52 : 0\.72/.test(
    chartSystem,
  ) &&
    /options\.window === 'ytd' \? yearStart : d3\.utcDay\.floor\(firstDate\)/.test(chartSystem) &&
    /curveCatmullRom\.alpha\(0\.5\)/.test(chartSystem),
  'chart-system.js',
  'shared demand rhythm must preserve adaptive density, calendar YTD, and the smooth trend curve',
);
check(
  /\.demand-rhythm__line\s*\{[^}]*stroke:\s*var\(--dpp-data3\)/s.test(chartCss),
  'chart-system.css',
  'shared demand rhythm must keep trend and daily bars visually distinct',
);
check(
  !/scaleBand|append\(['"]rect['"]\)/.test(todayScript),
  'today.js',
  'Today must not own a second bar-chart implementation',
);
check(
  !/<progress\b/i.test(trajectoryHtml) && !/trajectory-chart-scroll/.test(trajectoryHtml),
  'trajectory.html',
  'Trajectory must use the wide chart for evidence instead of progress bars or an internal scroller',
);
check(
  !/\.trajectory-chart\s*\{[^}]*\b(?:min-)?width:\s*\d+px/s.test(trajectoryCss),
  'trajectory.css',
  'Trajectory chart must not force a fixed pixel width',
);
check(
  /aggregateSeriesByWeek/.test(chartSystem) && />\s*120/.test(chartSystem),
  'chart-system.js',
  'long trajectory windows must aggregate daily bars for readable density',
);
check(
  /let expanded\s*=\s*false/.test(dataHealthScript),
  'data-health.js',
  'healthy state must default to compact pipeline exceptions',
);
check(
  (dataHealthScript.match(/expanded\s*=/g) || []).length === 2 &&
    /expanded\s*=\s*!expanded/.test(dataHealthScript),
  'data-health.js',
  'automatic refresh must preserve the chosen pipeline visibility',
);
for (const pageStyle of Object.values(pageStyles)) {
  const pageCss = readFileSync(join(staticRoot, pageStyle), 'utf8');
  check(
    !/\/\*\s*(?:Corrected .* recipe|Connected .* workspace)/i.test(pageCss),
    pageStyle,
    'route CSS must contain one canonical composition, not an appended correction layer',
  );
  const routeRoot = routeStyleRoots[pageStyle];
  if (routeRoot) {
    const selectorOwners = new Map();
    const routeRootSelector = new RegExp(`^(?:body)?\\.${routeRoot}(?![\\w-])\\s+`);
    const routeAst = postcss.parse(pageCss, { from: pageStyle });
    let responsiveLayersStarted = false;
    check(
      !new RegExp(`(?:^|,|\\n)\\s*(?:body)?\\.${routeRoot}(?![\\w-])\\s+`, 'm').test(pageCss),
      pageStyle,
      `route stylesheet must rely on its owned load position instead of .${routeRoot} specificity`,
    );
    routeAst.each((node) => {
      if (node.type === 'atrule' && node.name === 'media') responsiveLayersStarted = true;
      check(
        !responsiveLayersStarted || node.type !== 'rule',
        pageStyle,
        'base component rules must stay before responsive media blocks',
      );
    });
    routeAst.walkRules((rule) => {
      const context = [];
      for (let parent = rule.parent; parent && parent.type !== 'root'; parent = parent.parent) {
        if (parent.type === 'atrule') context.unshift(`@${parent.name} ${parent.params}`);
      }
      const selector = rule.selector
        .split(',')
        .map((part) => part.trim().replace(routeRootSelector, '').replaceAll(/\s+/g, ' '))
        .join(',');
      const owner = `${context.join(' > ')} :: ${selector}`;
      check(
        !selectorOwners.has(owner),
        pageStyle,
        `${selector} has more than one owner in the same responsive context`,
      );
      selectorOwners.set(owner, rule.source.start.line);
    });
  }
  for (const primitive of [
    'workspace',
    'panel--chart',
    'chart-host',
    'segmented-control',
    'segmented-control__item',
    'choice-group',
    'choice-control',
  ]) {
    check(
      !new RegExp(`(?:^|\\n)\\.${primitive.replaceAll('-', '\\-')}(?![\\w-])\\s*\\{`, 'm').test(pageCss),
      pageStyle,
      `shared primitive .${primitive} must be owned by layout-system.css`,
    );
  }
}
check(
  /class=["'][^"']*analysis-modes[^"']*choice-group/.test(catalogHtml) &&
    /class=["'][^"']*filters[^"']*choice-group/.test(catalogHtml) &&
    /class=["'][^"']*mode[^"']*choice-control/.test(catalogHtml) &&
    /class=["'][^"']*filter[^"']*choice-control/.test(catalogHtml) &&
    /class=\"mode choice-control/.test(catalogScript),
  'catalog.html',
  'Products analysis modes and filters must use the shared choice-control primitive',
);
check(
  /class=["'][^"']*filters[^"']*choice-group/.test(inventoryHtml) &&
    /class=["'][^"']*filter[^"']*choice-control/.test(inventoryHtml) &&
    /class=["'][^"']*btn[^"']*how-btn/.test(inventoryHtml),
  'inventory.html',
  'Inventory filters and explanation action must use shared control primitives',
);

const contractedControlHeightSelector =
  /\.(?:btn|subnav__item|segmented-control__item|choice-control|rule-trigger|mode|filter|how-btn)(?![\w-])/;
for (const stylesheet of ['theme.css', 'layout-system.css', ...Object.values(pageStyles)]) {
  const css = readFileSync(join(staticRoot, stylesheet), 'utf8');
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim();
    const contractedSelector = selector.replaceAll(/:not\([^)]*\)/g, '');
    const declarations = match[2];
    for (const fontSize of declarations.matchAll(/font-size:\s*([\d.]+)px/g)) {
      check(
        Number(fontSize[1]) >= 14,
        stylesheet,
        `${selector} hard-codes text below the 14px rendered contract`,
      );
    }
    if (contractedControlHeightSelector.test(contractedSelector)) {
      for (const minHeight of declarations.matchAll(/min-height:\s*([\d.]+)px/g)) {
        check(
          Number(minHeight[1]) >= 40,
          stylesheet,
          `${selector} hard-codes a control below the 40px rendered contract`,
        );
      }
    }
  }
}
check(
  /@media \(prefers-reduced-motion: reduce\)/.test(theme) &&
    /transition:\s*none !important/.test(theme) &&
    /animation:\s*none !important/.test(theme) &&
    !/transition-duration:\s*0\.01ms !important/.test(theme),
  'theme.css',
  'shared presentation layer must disable CSS motion without creating transitions for reduced-motion preferences',
);
check(
  /matchMedia\('\(prefers-reduced-motion: reduce\)'\)/.test(salesGeographyScript),
  'sales-geography-v2.js',
  'scripted map zoom must respect reduced-motion preferences',
);
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
