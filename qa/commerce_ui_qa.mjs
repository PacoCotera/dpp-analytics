import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const failures = [];

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function assert(condition, message) {
  if (!condition) failures.push(message);
}

const routes = [
  {
    name: "Catalog",
    html: read("board/static/catalog.html"),
    css: read("board/static/catalog.css"),
    js: read("board/static/catalog.js"),
    anchors: [
      "catalog-overview",
      "catalog-decisions",
      "catalog-controls",
      "catalog-evidence",
    ],
    controls: [".mode,", ".filter {", ".search,", ".select {"],
  },
  {
    name: "Product Workspace",
    html: read("board/static/product.html"),
    css: read("board/static/product.css"),
    js: read("board/static/product.js"),
    anchors: [
      "product-identity",
      "product-kpis",
      "product-analysis",
      "product-decisions",
      "product-order-evidence",
      "product-family-evidence",
    ],
    controls: [
      ".product-range .segmented-control__item,",
      ".orders-more {",
      ".hero-signal .rule-trigger {",
    ],
  },
  {
    name: "Inventory",
    html: read("board/static/inventory.html"),
    css: read("board/static/inventory.css"),
    js: read("board/static/inventory.js"),
    anchors: [
      "inventory-overview",
      "inventory-actions",
      "inventory-controls",
      "inventory-records",
      "inventory-evidence",
    ],
    controls: [".how-btn {", ".search {", ".filter {"],
  },
];
const browserQa = read("qa/commerce_ui_browser_qa.mjs");

const paletteLiteral =
  /#[0-9a-f]{3,8}\b|(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\s*\(/i;

for (const route of routes) {
  const h1s = route.html.match(/<h1\b/g) || [];
  assert(
    h1s.length === 1,
    `${route.name}: expected one H1, found ${h1s.length}`,
  );
  assert(
    route.html.includes("<main"),
    `${route.name}: missing semantic main landmark`,
  );
  assert(
    route.html.includes("/assets/presentation-registry.js") &&
      route.html.includes("/assets/presentation.js") &&
      route.html.includes("/assets/presentation-profiles.css"),
    `${route.name}: does not use the approved presentation-profile stack`,
  );
  assert(
    !route.html.includes("/assets/metric-basis-ui.js"),
    `${route.name}: metric-basis-ui.js remains a second post-render owner`,
  );

  for (const anchor of route.anchors) {
    assert(
      route.html.includes(`data-dpp-qa="${anchor}"`),
      `${route.name}: missing ${anchor} QA anchor`,
    );
  }

  assert(
    !paletteLiteral.test(route.css),
    `${route.name}: page CSS contains a palette literal`,
  );
  const undersizedText = [
    ...route.css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g),
  ]
    .map((match) => Number(match[1]))
    .filter((size) => size < 14);
  assert(
    undersizedText.length === 0,
    `${route.name}: contains evidence text below 14px (${undersizedText.join(", ")})`,
  );
  assert(
    route.css.includes("@media (max-width:") &&
      route.css.includes("var(--dpp-panel-texture, none)"),
    `${route.name}: missing responsive/profile-aware route treatment`,
  );

  for (const selector of route.controls) {
    const start = route.css.indexOf(selector);
    const block =
      start < 0
        ? ""
        : route.css.slice(start, route.css.indexOf("}", start) + 1);
    assert(start >= 0, `${route.name}: missing ${selector} control rule`);
    assert(
      block.includes("min-height: var(--control-height)"),
      `${route.name}: ${selector} does not use the shared 40–44px control height`,
    );
  }
}

const catalog = routes[0];
assert(
  !catalog.html.includes("catalog-ads-context.js"),
  "Catalog: superseded Ads context script is loaded",
);
assert(
  !catalog.js.includes("MutationObserver"),
  "Catalog: MutationObserver post-render ownership remains",
);
assert(
  (catalog.js.match(/fetchJson\('\/api\/catalog'\)/g) || []).length === 1,
  "Catalog: catalog.js must own exactly one cached /api/catalog request",
);
assert(
  catalog.js.includes("readCatalogUrlState") &&
    catalog.js.includes("writeCatalogUrlState") &&
    catalog.js.includes("window.addEventListener('popstate'"),
  "Catalog: URL-restored mode/filter state contract is missing",
);
assert(
  catalog.html.includes('type="search"') &&
    catalog.html.includes('aria-live="polite"') &&
    catalog.js.includes("catalog-reference-disclosure"),
  "Catalog: accessible search/results/mobile disclosure contract is incomplete",
);
assert(
  catalog.js.includes(
    "closest('.catalog-filter-field').hidden = !familyMode",
  ) &&
    catalog.css.includes(".catalog-filter-field[hidden]") &&
    browserQa.includes('for (const mode of ["dimension:ruling", "deleted"])'),
  "Catalog: the labeled family-filter field is not gated in every non-family mode",
);
assert(
  catalog.css.includes("@media (max-width: 1200px)") &&
    catalog.css.includes("overflow: visible") &&
    !catalog.js.includes('<a class="child"') &&
    catalog.js.includes("</summary>\n    ${familyRule ?"),
  "Catalog: responsive card containment or non-nested row interaction structure is incomplete",
);
assert(
  catalog.js.includes("return percent(value, { sign: false })") &&
    catalog.js.includes("Number.isFinite(Number(value))"),
  "Catalog: percent evidence does not preserve the shared malformed-value fallback",
);

const product = routes[1];
assert(
  product.js.includes("new URLSearchParams(window.location.search).get('sku')"),
  "Product Workspace: sku query context is not preserved",
);
assert(
  product.html.includes('aria-label="Demand chart metric"') &&
    product.html.includes('aria-label="Demand chart range"') &&
    product.html.includes('aria-expanded="false"'),
  "Product Workspace: chart/disclosure accessibility state is incomplete",
);
assert(
  product.css.includes(".product-page .dpp-chart .dpp-axis text") &&
    product.css.includes(".product-page .dpp-chart-tooltip"),
  "Product Workspace: chart evidence does not meet the route readability contract",
);
assert(
  product.js.includes("dataset.tone = tone") &&
    product.js.includes("profile.inventory_action === 'STOCKOUT'") &&
    product.js.includes("tone = 'critical'") &&
    product.css.includes(".decision-block--inventory[data-tone='critical']") &&
    product.css.includes(".decision-block--inventory[data-tone='warning']") &&
    product.css.includes(".decision-block--inventory[data-tone='healthy']"),
  "Product Workspace: inventory rail tone is not mapped from explicit decision semantics",
);
assert(
  product.css.includes(".decision-block--inventory,") &&
    product.css.includes(".decision-block--listing {") &&
    product.js.includes("Number.isFinite(Number(value))"),
  "Product Workspace: tablet rail dividers or malformed percentage fallback regressed",
);

const inventory = routes[2];
assert(
  inventory.html.includes("<caption>") &&
    (inventory.html.match(/scope="col"/g) || []).length === 10 &&
    inventory.js.includes('<th scope="row">'),
  "Inventory: semantic evidence-table caption or header scope is incomplete",
);
assert(
  inventory.html.includes('aria-controls="how"') &&
    inventory.js.includes("setAttribute('aria-expanded', String(expanded))") &&
    inventory.js.includes("setAttribute('aria-pressed', 'true')"),
  "Inventory: disclosure/filter accessibility state is incomplete",
);
assert(
  inventory.css.includes(".inventory-reference summary") &&
    inventory.css.includes(".inventory-cards") &&
    inventory.css.includes("position: sticky"),
  "Inventory: mobile disclosure/cards or sticky table evidence is missing",
);

assert(
  browserQa.includes(
    "const widthMatrix = [320, 720, 721, 768, 900, 901, 1024, 1180, 1600]",
  ),
  "Commerce browser QA: the required responsive width matrix is incomplete",
);
assert(
  browserQa.includes("undersizedTargets.length === 0") &&
    browserQa.includes("undersizedPrimary.length === 0") &&
    browserQa.includes("smallText.length === 0") &&
    browserQa.includes("state.overflow <= 1") &&
    browserQa.includes("state.nested === 0") &&
    browserQa.includes("state.visibleAnchors.length === route.anchors.length"),
  "Commerce browser QA: overflow, size, interaction, or hierarchy checks are not hard gates",
);

if (failures.length) {
  console.error(
    `Commerce UI QA failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
  );
  process.exit(1);
}

console.log(
  "Commerce UI QA passed: Catalog, Product Workspace and Inventory use semantic profiles, anchored hierarchy, readable evidence, accessible controls, and one Catalog runtime owner.",
);
