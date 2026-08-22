/* Compatibility entrypoint: activate the current postal geography renderer. */
(() => {
  'use strict';

  // Geography v2 removes the redundant selected-metric column. Keep the stable
  // page markup compatible without carrying two competing table schemas.
  const header = document.querySelector('.geo-table thead tr');
  if (header?.children?.length === 6) header.children[1].remove();

  const source = document.querySelector('.geo-map-source');
  if (source) {
    source.textContent =
      'Postal labels: SEPOMEX · polygon source: open-mexico / SEPOMEX · geometry is filtered server-side to postal codes present in the selected demand slice.';
  }

  // The zoom hardening layer owns map gestures, so it also needs a stable way
  // to dismiss any geography/chart tooltip before a pan begins. Keep this
  // compatibility hook here until the v2 + fixes split is consolidated.
  window.hideTip = () => {
    document
      .querySelectorAll('.geo-map-tooltip, .dpp-chart-tooltip')
      .forEach((tip) => tip.classList.remove('show'));
  };

  const current = document.currentScript?.src || '';
  let version = '';
  try {
    version = new URL(current, window.location.href).search;
  } catch (_) {
    version = '';
  }

  const loadFixes = () => {
    const fixes = document.createElement('script');
    fixes.src = `/assets/sales-geography-fixes.js${version}`;
    fixes.async = false;
    document.body.appendChild(fixes);
  };

  const script = document.createElement('script');
  script.src = `/assets/sales-geography-v2.js${version}`;
  script.async = false;
  script.addEventListener('load', loadFixes, { once: true });
  document.currentScript?.after(script);
})();
