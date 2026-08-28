/* Lazy compatibility entrypoint for the consolidated geography renderer. */
(() => {
  'use strict';

  const current = document.currentScript?.src || '';
  let version = '';
  let loading = false;

  try {
    version = new URL(current, window.location.href).search;
  } catch (_) {
    version = '';
  }

  function prepareMarkup() {
    const header = document.querySelector('.geo-table thead tr');
    if (header?.children?.length === 6) header.children[1].remove();

    const source = document.querySelector('.geo-map-source');
    if (source) {
      source.textContent =
        'State boundaries: geoBoundaries / INEGI (CC BY 3.0 IGO) · postal polygons: open-mexico / SEPOMEX (MIT) · pinned and bundled with this DPP release; postal geometry is filtered server-side to the selected demand slice.';
    }

    window.hideTip = () => {
      document
        .querySelectorAll('.geo-map-tooltip, .dpp-chart-tooltip')
        .forEach((tip) => tip.classList.remove('show'));
    };
  }

  function loadRenderer() {
    if (loading || document.querySelector('script[data-dpp-geography-renderer]')) return;
    loading = true;
    prepareMarkup();
    const script = document.createElement('script');
    script.type = 'module';
    script.src = `/assets/sales-geography-v2.js${version}`;
    script.dataset.dppGeographyRenderer = 'true';
    document.body.appendChild(script);
  }

  window.addEventListener('dpp:sales-view', (event) => {
    if (event.detail?.view === 'geography') loadRenderer();
  });

  if (new URLSearchParams(window.location.search).get('view') === 'geography') loadRenderer();
})();
