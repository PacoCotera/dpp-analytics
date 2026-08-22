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

  const current = document.currentScript?.src || '';
  let version = '';
  try {
    version = new URL(current, window.location.href).search;
  } catch (_) {
    version = '';
  }
  const script = document.createElement('script');
  script.src = `/assets/sales-geography-v2.js${version}`;
  script.async = false;
  document.currentScript?.after(script);
})();
