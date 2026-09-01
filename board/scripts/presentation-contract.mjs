import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BOARD_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REGISTRY_PATH = path.join(BOARD_ROOT, 'presentation', 'profiles.json');
const SCHEMA_PATH = path.join(BOARD_ROOT, 'presentation', 'profile.schema.json');
const BUILD_PATH = path.join(BOARD_ROOT, 'scripts', 'build-presentation-profiles.mjs');
const RUNTIME_PATH = path.join(BOARD_ROOT, 'static', 'presentation.js');

export const EXPECTED_PROFILE_IDS = Object.freeze([
  'warm-studio',
  'midnight-saffron',
  'aubergine-aqua',
  'midnight-dark',
  'aubergine-dark',
  'weyland',
]);

export const COLOR_TOKEN_KEYS = Object.freeze([
  'canvas',
  'chrome',
  'header',
  'page',
  'surface',
  'surfaceSubtle',
  'surfaceRaised',
  'text',
  'textMuted',
  'textSubtle',
  'border',
  'borderStrong',
  'chromeText',
  'chromeMuted',
  'chromeBorder',
  'chromeActive',
  'chromeActiveText',
  'headerText',
  'headerMuted',
  'headerBorder',
  'interaction',
  'interactionHover',
  'interactionActive',
  'interactionText',
  'focusRing',
  'brand',
  'brandSoft',
  'brandText',
  'data1',
  'data2',
  'data3',
  'data4',
  'data5',
  'data6',
  'dataIncomplete',
  'dataGrid',
  'healthy',
  'healthySurface',
  'healthyText',
  'warning',
  'warningSurface',
  'warningText',
  'critical',
  'criticalSurface',
  'criticalText',
  'info',
  'infoSurface',
  'infoText',
]);

export const VALUE_TOKEN_KEYS = Object.freeze([
  'fontBody',
  'fontDisplay',
  'fontDetail',
  'headingWeight',
  'kpiWeight',
  'bodySize',
  'metadataSize',
  'radiusSmall',
  'radiusMedium',
  'radiusLarge',
  'radiusPill',
  'borderWidth',
  'controlHeight',
  'shadowLow',
  'shadowHigh',
  'panelTexture',
  'motionDuration',
]);

export const TOKEN_KEYS = Object.freeze([...COLOR_TOKEN_KEYS, ...VALUE_TOKEN_KEYS]);

const ROOT_KEYS = [
  'schemaVersion',
  'defaultProfileId',
  'storageKey',
  'paletteRevision',
  'paletteNote',
  'profiles',
];

const PROFILE_KEYS = [
  'id',
  'displayName',
  'description',
  'paletteProvenance',
  'colorScheme',
  'themeColor',
  'shell',
  'profile',
  'density',
  'surfaceEmphasis',
  'typography',
  'geometry',
  'chartStyle',
  'effects',
  'tokens',
];

const CONTRAST_CHECKS = [
  ['text', 'page', 4.5],
  ['text', 'surface', 4.5],
  ['textMuted', 'page', 4.5],
  ['textMuted', 'surface', 4.5],
  ['textSubtle', 'page', 4.5],
  ['chromeText', 'chrome', 4.5],
  ['chromeMuted', 'chrome', 4.5],
  ['chromeActiveText', 'chromeActive', 4.5],
  ['headerText', 'header', 4.5],
  ['headerMuted', 'header', 4.5],
  ['interaction', 'page', 4.5],
  ['interaction', 'surface', 4.5],
  ['interactionText', 'interactionActive', 4.5],
  ['brandText', 'brandSoft', 4.5],
  ['healthyText', 'healthySurface', 4.5],
  ['warningText', 'warningSurface', 4.5],
  ['criticalText', 'criticalSurface', 4.5],
  ['infoText', 'infoSurface', 4.5],
  ['focusRing', 'page', 3],
  ['focusRing', 'surface', 3],
  ['borderStrong', 'page', 3],
  ['borderStrong', 'surface', 3],
  ['dataIncomplete', 'surface', 3],
  ...['data1', 'data2', 'data3', 'data4', 'data5', 'data6'].map((key) => [
    key,
    'surface',
    3,
  ]),
];

function fail(message) {
  throw new Error(`Presentation contract: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function assertExactKeys(value, expected, context) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${context} must be an object`);
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  assert(
    JSON.stringify(actualKeys) === JSON.stringify(expectedKeys),
    `${context} keys differ; expected ${expectedKeys.join(', ')}; received ${actualKeys.join(', ')}`,
  );
}

function channelToLinear(channel) {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const channels = hex
    .slice(1)
    .match(/../g)
    .map((channel) => channelToLinear(Number.parseInt(channel, 16)));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground, background) {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
}

function validateProfile(profile, index) {
  const context = `profiles[${index}] (${profile?.id ?? 'unknown'})`;
  assertExactKeys(profile, PROFILE_KEYS, context);
  assert(EXPECTED_PROFILE_IDS[index] === profile.id, `${context} has the wrong ID or order`);
  assert(profile.displayName.trim(), `${context} needs a display name`);
  assert(profile.description.trim(), `${context} needs a description`);
  assert(
    profile.paletteProvenance === 'implementation-defined',
    `${context} must identify its palette as implementation-defined`,
  );
  assert(['light', 'dark'].includes(profile.colorScheme), `${context} has an invalid color scheme`);
  assert(/^#[0-9A-Fa-f]{6}$/.test(profile.themeColor), `${context} has an invalid theme color`);
  assert(
    profile.shell === 'persistent-domain-sidebar',
    `${context} must use the approved persistent sidebar shell`,
  );
  assert(['standard', 'weyland'].includes(profile.profile), `${context} has an invalid profile`);
  assert(profile.density === 'comfortable', `${context} must preserve long-session readability`);
  assert(
    ['quiet', 'tinted', 'expressive'].includes(profile.surfaceEmphasis),
    `${context} has an invalid surface emphasis`,
  );
  assertExactKeys(profile.tokens, TOKEN_KEYS, `${context}.tokens`);

  for (const key of COLOR_TOKEN_KEYS) {
    assert(/^#[0-9A-Fa-f]{6}$/.test(profile.tokens[key]), `${context} token ${key} must be #RRGGBB`);
  }
  for (const key of VALUE_TOKEN_KEYS) {
    assert(
      typeof profile.tokens[key] === 'string' && profile.tokens[key].trim(),
      `${context} token ${key} must be a non-empty CSS value`,
    );
  }

  for (const [foregroundKey, backgroundKey, minimum] of CONTRAST_CHECKS) {
    const ratio = contrastRatio(profile.tokens[foregroundKey], profile.tokens[backgroundKey]);
    assert(
      ratio >= minimum,
      `${context} ${foregroundKey}/${backgroundKey} contrast is ${ratio.toFixed(2)}; expected ${minimum}:1`,
    );
  }

  assert(profile.themeColor === profile.tokens.header, `${context} themeColor must match header`);
  assert(Number.parseFloat(profile.tokens.bodySize) >= 15, `${context} body text is below 15px`);
  assert(Number.parseFloat(profile.tokens.metadataSize) >= 14, `${context} metadata is below 14px`);
  assert(Number.parseFloat(profile.tokens.controlHeight) >= 44, `${context} controls are below 44px`);

  const semanticColors = new Set([
    profile.tokens.interaction,
    profile.tokens.interactionActive,
    profile.tokens.brand,
    profile.tokens.healthy,
    profile.tokens.warning,
    profile.tokens.critical,
    profile.tokens.info,
  ]);
  for (const key of ['data1', 'data2', 'data3', 'data4', 'data5', 'data6']) {
    assert(
      !semanticColors.has(profile.tokens[key]),
      `${context} ${key} must remain independent from interaction, brand, and status colors`,
    );
  }
}

export function validateRegistry(registry) {
  assertExactKeys(registry, ROOT_KEYS, 'registry');
  assert(registry.schemaVersion === 1, 'schemaVersion must be 1');
  assert(registry.defaultProfileId === 'warm-studio', 'Warm Studio must be the safe default');
  assert(registry.storageKey === 'dpp.presentation.v1', 'storage key must remain versioned');
  assert(registry.paletteRevision.trim(), 'palette revision is required');
  assert(
    /implementation values/i.test(registry.paletteNote) &&
      /not source-extracted swatches/i.test(registry.paletteNote),
    'palette note must identify implementation values and reject false source attribution',
  );
  assert(Array.isArray(registry.profiles), 'profiles must be an array');
  assert(registry.profiles.length === EXPECTED_PROFILE_IDS.length, 'registry must contain exactly six profiles');
  registry.profiles.forEach(validateProfile);

  const ids = registry.profiles.map(({ id }) => id);
  assert(new Set(ids).size === ids.length, 'profile IDs must be unique');
  assert(
    JSON.stringify(ids) === JSON.stringify(EXPECTED_PROFILE_IDS),
    'profile IDs or their authoritative order changed',
  );

  const lightProfiles = registry.profiles.filter(({ colorScheme }) => colorScheme === 'light');
  const darkProfiles = registry.profiles.filter(({ colorScheme }) => colorScheme === 'dark');
  assert(lightProfiles.length === 3 && darkProfiles.length === 3, 'registry must contain three light and three dark choices');

  for (const id of ['midnight-saffron', 'aubergine-aqua']) {
    const profile = registry.profiles.find((candidate) => candidate.id === id);
    assert(profile.surfaceEmphasis === 'tinted', `${id} must default to tinted semantic surfaces`);
  }

  const warm = registry.profiles[0];
  assert(warm.surfaceEmphasis === 'quiet', 'Warm Studio must remain the quiet reference profile');

  const weyland = registry.profiles.at(-1);
  assert(weyland.profile === 'weyland', 'Weyland must be a full presentation profile');
  assert(weyland.colorScheme === 'dark', 'Weyland must use a dark color scheme');
  assert(weyland.typography === 'terminal', 'Weyland must use terminal typography');
  assert(weyland.geometry === 'precision', 'Weyland must use precision geometry');
  assert(weyland.chartStyle === 'outlined-vector', 'Weyland must use vector chart styling');
  assert(weyland.effects === 'instrument', 'Weyland must use restrained instrument effects');
  assert(weyland.surfaceEmphasis === 'expressive', 'Weyland must retain expressive surface emphasis');
  assert(!/monospace/.test(weyland.tokens.fontBody), 'Weyland body copy must retain the readable UI sans stack');
  assert(/monospace/.test(weyland.tokens.fontDisplay), 'Weyland display type must be monospaced');
  assert(Number.parseInt(weyland.tokens.headingWeight, 10) >= 800, 'Weyland headings must be blocky and bold');
  assert(Number.parseInt(weyland.tokens.kpiWeight, 10) >= 800, 'Weyland KPI values must be blocky and bold');

  return registry;
}

async function runContract() {
  const [registrySource, schemaSource, runtimeSource] = await Promise.all([
    readFile(REGISTRY_PATH, 'utf8'),
    readFile(SCHEMA_PATH, 'utf8'),
    readFile(RUNTIME_PATH, 'utf8'),
  ]);
  const registry = validateRegistry(JSON.parse(registrySource));
  const schema = JSON.parse(schemaSource);
  const schemaIds = schema.properties?.profiles?.items?.properties?.id?.enum;
  assert(
    JSON.stringify(schemaIds) === JSON.stringify(EXPECTED_PROFILE_IDS),
    'JSON Schema profile IDs differ from the registry contract',
  );

  const runtimeMarkers = [
    registry.storageKey,
    'data-dpp-theme',
    'dpp:presentationchange',
    "addEventListener('storage'",
    "meta[name='theme-color']",
    "meta[name='color-scheme']",
    'CustomEvent',
  ];
  for (const marker of runtimeMarkers) {
    assert(runtimeSource.includes(marker), `runtime is missing required behavior marker: ${marker}`);
  }
  assert(
    !runtimeSource.includes('root.style.colorScheme'),
    'runtime must use generated profile CSS for CSP-safe color-scheme application',
  );
  new Function(runtimeSource);

  const build = spawnSync(process.execPath, [BUILD_PATH, '--check'], {
    cwd: BOARD_ROOT,
    encoding: 'utf8',
  });
  if (build.stdout) process.stdout.write(build.stdout);
  if (build.stderr) process.stderr.write(build.stderr);
  assert(build.status === 0, 'generated presentation assets are stale');

  process.stdout.write(
    `Presentation contract passed: ${registry.profiles.length} profiles, AA text/status pairs, and current generated assets.\n`,
  );
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runContract().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
