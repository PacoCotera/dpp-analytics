import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const baseUrl = (process.argv[2] || 'http://127.0.0.1:8088').replace(/\/$/, '');
const outDir = process.argv[3] || '/out';
const storageKey = 'dpp.presentation.v1';
const expectedProfileIds = [
  'warm-studio',
  'midnight-saffron',
  'aubergine-aqua',
  'midnight-dark',
  'aubergine-dark',
  'weyland',
];

await fs.mkdir(outDir, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await context.addInitScript(
  ({ key, initialProfileId }) => {
    try {
      if (!localStorage.getItem(key)) {
        localStorage.setItem(
          key,
          JSON.stringify({ schemaVersion: 1, profileId: initialProfileId }),
        );
      }
    } catch {
      // about:blank and privacy-restricted documents may not expose storage.
    }
    window.__dppFirstFrameTheme = new Promise((resolve) => {
      requestAnimationFrame(() => {
        resolve(document.documentElement.getAttribute('data-dpp-theme'));
      });
    });
  },
  { key: storageKey, initialProfileId: 'midnight-dark' },
);

const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});

const response = await page.goto(baseUrl + '/business', {
  waitUntil: 'domcontentloaded',
  timeout: 20_000,
});
assert(response?.ok(), `Business navigation failed with ${response?.status()}`);
await page.locator('.appearance-trigger').waitFor({ timeout: 5_000 });

const firstFrameTheme = await page.evaluate(() => window.__dppFirstFrameTheme);
assert(
  firstFrameTheme === 'midnight-dark',
  `first rendering opportunity used ${firstFrameTheme}, expected midnight-dark`,
);

const contract = await page.evaluate(() => {
  const registry = window.DPP_PRESENTATION_REGISTRY;
  const runtime = window.dppPresentation;
  return {
    ids: registry.profiles.map(({ id }) => id),
    registryFrozen: Object.isFrozen(registry),
    profilesFrozen: Object.isFrozen(registry.profiles),
    profileFrozen: registry.profiles.every((profile) => Object.isFrozen(profile)),
    defaultProfileId: registry.defaultProfileId,
    storageKey: runtime.storageKey,
    api: ['getProfile', 'getProfileId', 'listProfiles', 'reset', 'setProfile'].filter(
      (key) => typeof runtime[key] === 'function',
    ),
    rootTheme: document.documentElement.getAttribute('data-dpp-theme'),
    optionValues: [...document.querySelectorAll('input[name="dpp-appearance"]')].map(
      (input) => input.value,
    ),
  };
});

assert(
  JSON.stringify(contract.ids) === JSON.stringify(expectedProfileIds),
  `profile registry differs: ${JSON.stringify(contract.ids)}`,
);
assert(
  contract.registryFrozen && contract.profilesFrozen && contract.profileFrozen,
  'presentation registry is mutable',
);
assert(contract.defaultProfileId === 'warm-studio', 'Warm Studio is not the safe default');
assert(contract.storageKey === storageKey, `runtime storage key is ${contract.storageKey}`);
assert(contract.api.length === 5, `presentation API is incomplete: ${contract.api}`);
assert(contract.rootTheme === 'midnight-dark', `restored theme is ${contract.rootTheme}`);
assert(
  JSON.stringify(contract.optionValues) === JSON.stringify(expectedProfileIds),
  `Appearance choices differ: ${JSON.stringify(contract.optionValues)}`,
);

const profileChecks = [];
for (const profileId of expectedProfileIds) {
  const result = await page.evaluate((id) => {
    const profile = window.dppPresentation.setProfile(id);
    const root = document.documentElement;
    return {
      id,
      active: window.dppPresentation.getProfileId(),
      rootTheme: root.getAttribute('data-dpp-theme'),
      rootProfile: root.getAttribute('data-dpp-profile'),
      chartStyle: root.getAttribute('data-dpp-chart-style'),
      colorScheme: root.style.colorScheme,
      themeColor: document.querySelector("meta[name='theme-color']")?.content,
      stored: JSON.parse(localStorage.getItem(window.dppPresentation.storageKey)),
      canvas: getComputedStyle(root).getPropertyValue('--dpp-canvas').trim(),
      selected: document.querySelector('input[name="dpp-appearance"]:checked')?.value,
      expected: {
        profile: profile.profile,
        chartStyle: profile.chartStyle,
        colorScheme: profile.colorScheme,
        themeColor: profile.themeColor,
      },
    };
  }, profileId);

  assert(result.active === profileId, `${profileId} did not become active`);
  assert(result.rootTheme === profileId, `${profileId} root attribute was not applied`);
  assert(result.rootProfile === result.expected.profile, `${profileId} profile attribute differs`);
  assert(result.chartStyle === result.expected.chartStyle, `${profileId} chart style differs`);
  assert(result.colorScheme === result.expected.colorScheme, `${profileId} color scheme differs`);
  assert(result.themeColor === result.expected.themeColor, `${profileId} browser chrome differs`);
  assert(result.stored?.profileId === profileId, `${profileId} was not persisted`);
  assert(result.selected === profileId, `${profileId} Appearance choice is not selected`);
  assert(result.canvas, `${profileId} generated CSS tokens are unavailable`);
  profileChecks.push(result);
}

const structure = await page.evaluate(() => ({
  h1: [...document.querySelectorAll('main h1')].map((heading) => heading.textContent.trim()),
  pageRecipes: [...document.querySelectorAll('main section[data-dpp-qa]')].map(
    (section) => section.getAttribute('data-dpp-qa'),
  ),
  kpis: document.querySelectorAll('.home-kpi-rail > .kpi').length,
  healthCards: document.querySelectorAll('.business-health-grid > .business-health-card').length,
  skipTarget: document.querySelector('.skip-link')?.getAttribute('href'),
  mainId: document.querySelector('main')?.previousElementSibling?.id,
}));
assert(structure.h1.length === 1, 'Business must have one h1');
assert(
  JSON.stringify(structure.pageRecipes) === JSON.stringify([
    'business-overview',
    'business-demand',
    'business-decisions',
    'business-health',
  ]),
  `Business hierarchy differs: ${JSON.stringify(structure.pageRecipes)}`,
);
assert(structure.kpis === 4, `Business KPI rail contains ${structure.kpis} items`);
assert(structure.healthCards === 3, 'Business health must contain three decision domains');
assert(structure.skipTarget === '#main-content' && structure.mainId === 'main-content', 'skip link is broken');

await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 });
await page.locator('.appearance-trigger').waitFor({ timeout: 5_000 });
const restored = await page.evaluate(async () => ({
  firstFrameTheme: await window.__dppFirstFrameTheme,
  active: window.dppPresentation.getProfileId(),
}));
assert(
  restored.firstFrameTheme === 'weyland' && restored.active === 'weyland',
  `persisted profile restored as ${JSON.stringify(restored)}`,
);

await page.evaluate((key) => localStorage.setItem(key, '{invalid'), storageKey);
await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 });
await page.locator('.appearance-trigger').waitFor({ timeout: 5_000 });
const fallback = await page.evaluate(async (key) => ({
  firstFrameTheme: await window.__dppFirstFrameTheme,
  active: window.dppPresentation.getProfileId(),
  stored: localStorage.getItem(key),
}), storageKey);
assert(
  fallback.firstFrameTheme === 'warm-studio' && fallback.active === 'warm-studio',
  `invalid preference did not use Warm Studio: ${JSON.stringify(fallback)}`,
);
assert(fallback.stored === null, 'invalid presentation preference was not removed');

await page.screenshot({
  path: path.join(outDir, 'presentation-business-warm-studio.png'),
  fullPage: true,
});
await browser.close();

const summary = {
  baseUrl,
  firstFrameTheme,
  profileChecks,
  structure,
  restored,
  fallback,
  errors,
  ok: errors.length === 0,
};
await fs.writeFile(
  path.join(outDir, 'presentation-profiles-summary.json'),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify({ presentationProfilesQA: summary }, null, 2));
if (errors.length) process.exitCode = 3;
