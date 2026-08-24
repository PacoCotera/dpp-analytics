(() => {
  'use strict';

  if (window.DPPDataCache) return;

  const VERSION = 'v1';
  const memory = new Map();
  const inflight = new Map();
  const policies = [
    [/^\/api\/today(?:\?|$)/, 15_000],
    [/^\/api\/home(?:\?|$)/, 30_000],
    [/^\/api\/sales(?:\?|$)/, 60_000],
    [/^\/api\/catalog(?:\?|$)/, 300_000],
    [/^\/api\/inventory(?:\?|$)/, 60_000],
    [/^\/api\/finance(?:\?|$)/, 300_000],
    [/^\/api\/ads(?:\?|$)/, 300_000],
    [/^\/api\/product(?:\?|$)/, 300_000],
    [/^\/api\/trajectory(?:\?|$)/, 600_000],
    [/^\/api\/data-health(?:\?|$)/, 30_000],
  ];

  function canonicalUrl(url) {
    const parsed = new URL(url, window.location.origin);
    if (parsed.origin !== window.location.origin) return parsed.href;
    parsed.searchParams.delete('refresh');
    parsed.searchParams.sort();
    return `${parsed.pathname}${parsed.search}`;
  }

  function ttlFor(url) {
    const key = canonicalUrl(url);
    return policies.find(([pattern]) => pattern.test(key))?.[1] || 0;
  }

  function storageKey(key) {
    return `dpp:data-cache:${VERSION}:${key}`;
  }

  function readStorage(key) {
    const inMemory = memory.get(key);
    if (inMemory) return inMemory;
    try {
      const raw = window.sessionStorage.getItem(storageKey(key));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.storedAt !== 'number' || !('data' in parsed)) return null;
      memory.set(key, parsed);
      return parsed;
    } catch (_) {
      return null;
    }
  }

  function writeStorage(key, entry) {
    memory.set(key, entry);
    try {
      window.sessionStorage.setItem(storageKey(key), JSON.stringify(entry));
    } catch (_) {
      // Large payloads or privacy-restricted browsers still retain same-page memory caching.
    }
  }

  function removeStorage(key) {
    memory.delete(key);
    try {
      window.sessionStorage.removeItem(storageKey(key));
    } catch (_) {
      // Storage is an optimization only.
    }
  }

  async function fetchJson(url, options = {}) {
    const {
      ttlMs = ttlFor(url),
      forceRefresh = false,
      fetchOptions = {},
    } = options;
    const method = String(fetchOptions.method || 'GET').toUpperCase();
    const key = canonicalUrl(url);
    const now = Date.now();

    if (method === 'GET' && !forceRefresh && ttlMs > 0) {
      const cached = readStorage(key);
      if (cached && now - cached.storedAt < ttlMs) return cached.data;
    }

    if (method === 'GET' && !forceRefresh && inflight.has(key)) return inflight.get(key);

    const requestUrl = forceRefresh
      ? (() => {
          const parsed = new URL(url, window.location.origin);
          parsed.searchParams.set('refresh', '1');
          return `${parsed.pathname}${parsed.search}`;
        })()
      : url;

    const request = (async () => {
      const response = await fetch(requestUrl, fetchOptions);
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      const data = await response.json();
      if (method === 'GET' && ttlMs > 0) writeStorage(key, { storedAt: Date.now(), data });
      window.dispatchEvent(
        new CustomEvent('dpp:data-cache-updated', {
          detail: {
            url: key,
            cacheStatus: response.headers.get('X-DPP-Cache') || 'NETWORK',
            cacheAge: Number(response.headers.get('X-DPP-Cache-Age') || 0),
          },
        }),
      );
      return data;
    })();

    if (method === 'GET' && !forceRefresh) inflight.set(key, request);
    try {
      return await request;
    } finally {
      if (inflight.get(key) === request) inflight.delete(key);
    }
  }

  function invalidate(url) {
    if (url) {
      removeStorage(canonicalUrl(url));
      return;
    }
    memory.clear();
    try {
      for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
        const key = window.sessionStorage.key(index);
        if (key?.startsWith(`dpp:data-cache:${VERSION}:`)) window.sessionStorage.removeItem(key);
      }
    } catch (_) {
      // Storage is an optimization only.
    }
  }

  window.DPPDataCache = Object.freeze({ fetchJson, invalidate, ttlFor });
})();
