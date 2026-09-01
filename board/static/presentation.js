(() => {
  'use strict';

  const FALLBACK_REGISTRY = Object.freeze({
    schemaVersion: 1,
    defaultProfileId: 'warm-studio',
    storageKey: 'dpp.presentation.v1',
    profiles: Object.freeze([
      Object.freeze({
        id: 'warm-studio',
        displayName: 'Warm Studio',
        colorScheme: 'light',
        themeColor: '#F7F3EC',
        profile: 'standard',
        density: 'comfortable',
        surfaceEmphasis: 'quiet',
        typography: 'humanist',
        geometry: 'soft',
        chartStyle: 'solid',
        effects: 'quiet',
      }),
    ]),
  });
  const EVENT_NAME = 'dpp:presentationchange';
  const root = document.documentElement;

  function isUsableRegistry(candidate) {
    return Boolean(
      candidate &&
        candidate.schemaVersion === 1 &&
        typeof candidate.storageKey === 'string' &&
        Array.isArray(candidate.profiles) &&
        candidate.profiles.some(({ id }) => id === candidate.defaultProfileId),
    );
  }

  const registry = isUsableRegistry(window.DPP_PRESENTATION_REGISTRY)
    ? window.DPP_PRESENTATION_REGISTRY
    : FALLBACK_REGISTRY;
  const profilesById = new Map(registry.profiles.map((profile) => [profile.id, profile]));
  const fallbackProfile = profilesById.get(registry.defaultProfileId);
  let activeProfile = null;

  function findOrCreateMeta(selector, name) {
    const current = document.head.querySelector(selector);
    if (current) return current;
    const meta = document.createElement('meta');
    meta.name = name;
    meta.dataset.dppPresentation = '';
    document.head.append(meta);
    return meta;
  }

  function syncBrowserChrome(profile) {
    const themeColor = findOrCreateMeta("meta[name='theme-color']", 'theme-color');
    const colorScheme = findOrCreateMeta("meta[name='color-scheme']", 'color-scheme');
    themeColor.content = profile.themeColor;
    colorScheme.content = profile.colorScheme;
  }

  function dispatchChange(previousProfile, profile, source) {
    window.dispatchEvent(
      new CustomEvent(EVENT_NAME, {
        detail: Object.freeze({
          previousProfileId: previousProfile?.id ?? null,
          profileId: profile.id,
          profile,
          source,
        }),
      }),
    );
  }

  function applyProfile(profile, source, notify = true) {
    const previousProfile = activeProfile;
    activeProfile = profile;
    root.setAttribute('data-dpp-theme', profile.id);
    root.setAttribute('data-dpp-profile', profile.profile);
    root.setAttribute('data-dpp-density', profile.density);
    root.setAttribute('data-dpp-surface-emphasis', profile.surfaceEmphasis);
    root.setAttribute('data-dpp-typography', profile.typography);
    root.setAttribute('data-dpp-geometry', profile.geometry);
    root.setAttribute('data-dpp-chart-style', profile.chartStyle);
    root.setAttribute('data-dpp-effects', profile.effects);
    syncBrowserChrome(profile);
    if (notify && (previousProfile?.id !== profile.id || source === 'reset')) {
      dispatchChange(previousProfile, profile, source);
    }
    return profile;
  }

  function parsePreference(rawValue) {
    if (!rawValue) return null;
    try {
      const preference = JSON.parse(rawValue);
      if (
        preference?.schemaVersion !== registry.schemaVersion ||
        typeof preference.profileId !== 'string' ||
        !profilesById.has(preference.profileId)
      ) {
        return null;
      }
      return preference;
    } catch {
      return null;
    }
  }

  function readStoredValue() {
    try {
      return window.localStorage.getItem(registry.storageKey);
    } catch {
      return null;
    }
  }

  function removeStoredValue() {
    try {
      window.localStorage.removeItem(registry.storageKey);
    } catch {
      // Storage may be unavailable in privacy-restricted contexts; the in-memory preference still applies.
    }
  }

  function writeStoredValue(profileId) {
    try {
      window.localStorage.setItem(
        registry.storageKey,
        JSON.stringify({ schemaVersion: registry.schemaVersion, profileId }),
      );
      return true;
    } catch {
      return false;
    }
  }

  function restoreProfile() {
    const rawValue = readStoredValue();
    const preference = parsePreference(rawValue);
    if (rawValue && !preference) removeStoredValue();
    return preference ? profilesById.get(preference.profileId) : fallbackProfile;
  }

  function setProfile(profileId, options = {}) {
    const profile = profilesById.get(profileId);
    if (!profile) throw new TypeError(`Unknown DPP presentation profile: ${profileId}`);
    if (options.persist !== false) writeStoredValue(profile.id);
    return applyProfile(profile, options.source ?? 'api');
  }

  function reset() {
    removeStoredValue();
    return applyProfile(fallbackProfile, 'reset');
  }

  function handleStorage(event) {
    if (event.key !== registry.storageKey) return;
    const preference = parsePreference(event.newValue);
    if (event.newValue && !preference) removeStoredValue();
    const profile = preference ? profilesById.get(preference.profileId) : fallbackProfile;
    applyProfile(profile, 'storage');
  }

  applyProfile(restoreProfile(), 'initial', false);
  window.addEventListener('storage', handleStorage);

  Object.defineProperty(window, 'dppPresentation', {
    value: Object.freeze({
      eventName: EVENT_NAME,
      storageKey: registry.storageKey,
      getProfile: () => activeProfile,
      getProfileId: () => activeProfile.id,
      listProfiles: () => registry.profiles,
      reset,
      setProfile,
    }),
    configurable: false,
    enumerable: true,
    writable: false,
  });

  const announceInitialProfile = () => dispatchChange(null, activeProfile, 'initial');
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', announceInitialProfile, { once: true });
  } else {
    Promise.resolve().then(announceInitialProfile);
  }
})();
