/* Geography rendering hardening: planar postal projection + explicit sort controls + local map zoom. */
(() => {
  'use strict';
  const d3 = window.d3;
  if (!d3) return;

  let ACTIVE_MAP_ZOOM = null;
  let zoomInstalling = false;

  const style = document.createElement('style');
  style.textContent = `
    .geo-ranked-header { align-items: flex-end; }
    .geo-ranked-heading { min-width: 0; }
    .geo-ranked-heading #geoSortStatus { margin-top: 3px; }
    .geo-sort-controls { display:flex; align-items:flex-end; justify-content:flex-end; gap:6px; flex:none; }
    .geo-sort-control { display:grid; gap:3px; }
    .geo-sort-control > span { color:var(--muted); font-size:8px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; }
    .geo-sort-control select { height:31px; min-width:104px; padding:0 25px 0 8px; border:1px solid var(--line); border-radius:9px; background:#fffdf9; color:var(--ink); font:inherit; font-size:10px; }
    .geo-sort-direction { height:31px; min-width:34px; padding:0 9px; border:1px solid var(--line); border-radius:9px; background:#fffdf9; color:var(--ink); font-size:13px; font-weight:800; cursor:pointer; }
    .geo-table { table-layout:fixed !important; }
    .geo-table col.geo-col-area { width:45% !important; }
    .geo-table col.geo-col-sales { width:18% !important; }
    .geo-table col.geo-col-orders { width:13% !important; }
    .geo-table col.geo-col-units { width:11% !important; }
    .geo-table col.geo-col-aov { width:13% !important; }
    .geo-table th, .geo-table td { padding-left:7px !important; padding-right:7px !important; }
    .geo-table td.num, .geo-table th.num { text-align:right; font-variant-numeric:tabular-nums; }
    .geo-table th[data-geo-sort] button { overflow:visible; }
    .geo-map { overflow:hidden !important; cursor:grab; touch-action:none; overscroll-behavior:contain; user-select:none; -webkit-user-select:none; }
    .geo-map.geo-map--panning { cursor:grabbing; }
    .geo-map-actions { display:flex; align-items:center; justify-content:flex-end; gap:7px; flex:none; }
    .geo-map-zoom { display:inline-flex; align-items:center; overflow:hidden; border:1px solid var(--line); border-radius:10px; background:#fffdf9; box-shadow:0 1px 0 rgb(32 29 25 / 3%); }
    .geo-map-zoom button { display:grid; width:32px; height:30px; place-items:center; padding:0; border:0; border-left:1px solid var(--line); background:transparent; color:var(--ink); font:inherit; font-size:15px; font-weight:800; line-height:1; cursor:pointer; }
    .geo-map-zoom button:first-child { border-left:0; }
    .geo-map-zoom button:hover:not(:disabled), .geo-map-zoom button:focus-visible { background:rgb(229 139 31 / 9%); outline:none; }
    .geo-map-zoom button:disabled { color:var(--muted); cursor:default; opacity:.42; }
    .geo-map-zoom .geo-map-reset { width:auto; min-width:48px; padding:0 8px; font-size:9px; font-weight:780; letter-spacing:.02em; }
    @media (max-width:720px) {
      .geo-ranked-header { align-items:flex-start; flex-direction:column; }
      .geo-sort-controls { width:100%; justify-content:flex-start; }
      .geo-sort-control { flex:1; }
      .geo-sort-control select { width:100%; }
      .geo-map-header { align-items:flex-start; }
      .geo-map-actions { gap:5px; }
      .geo-map-zoom button { width:30px; height:29px; }
      .geo-map-zoom .geo-map-reset { min-width:42px; padding:0 6px; }
    }
  `;
  document.head.appendChild(style);

  function ensureSortControls() {
    const header = document.querySelector('.geo-ranked-header');
    if (!header || header.querySelector('.geo-sort-controls')) return;

    const title = header.querySelector('#geoRankedTitle');
    const status = header.querySelector('#geoSortStatus');
    if (title && !title.parentElement?.classList.contains('geo-ranked-heading')) {
      const heading = document.createElement('div');
      heading.className = 'geo-ranked-heading';
      header.insertBefore(heading, title);
      heading.appendChild(title);
      if (status) heading.appendChild(status);
    }

    const controls = document.createElement('div');
    controls.className = 'geo-sort-controls';
    controls.innerHTML = `
      <label class="geo-sort-control">
        <span>Order by</span>
        <select id="geoOrderBy" aria-label="Order geography table by field">
          <option value="sales">Spend</option>
          <option value="orders">Orders</option>
          <option value="units">Units</option>
          <option value="aov">AOV</option>
          <option value="area">Area</option>
        </select>
      </label>
      <button class="geo-sort-direction" id="geoSortDirection" type="button" aria-label="Toggle sort direction" title="Toggle sort direction">↓</button>
    `;
    header.appendChild(controls);

    const select = controls.querySelector('#geoOrderBy');
    const direction = controls.querySelector('#geoSortDirection');

    function activeSort() {
      const active = document.querySelector('.geo-table th[data-geo-sort][aria-sort="ascending"], .geo-table th[data-geo-sort][aria-sort="descending"]');
      return {
        field: active?.dataset.geoSort || 'sales',
        direction: active?.getAttribute('aria-sort') === 'ascending' ? 'asc' : 'desc',
      };
    }

    function sync() {
      const current = activeSort();
      select.value = current.field;
      direction.textContent = current.direction === 'asc' ? '↑' : '↓';
      direction.setAttribute('aria-label', `Sort ${current.direction === 'asc' ? 'descending' : 'ascending'}`);
      direction.title = current.direction === 'asc' ? 'Sort descending' : 'Sort ascending';
    }

    function clickField(field) {
      document.querySelector(`.geo-table th[data-geo-sort="${field}"] button`)?.click();
    }

    function setSort(field, wantedDirection = 'desc') {
      let current = activeSort();
      if (current.field !== field) {
        clickField(field);
        current = activeSort();
      }
      if (current.direction !== wantedDirection) clickField(field);
      requestAnimationFrame(sync);
    }

    select.addEventListener('change', () => setSort(select.value, select.value === 'area' ? 'asc' : 'desc'));
    direction.addEventListener('click', () => {
      const current = activeSort();
      clickField(current.field);
      requestAnimationFrame(sync);
    });

    document.getElementById('geoMetric')?.addEventListener('change', (event) => {
      const field = event.target.value;
      if (['sales', 'orders', 'units', 'aov'].includes(field)) setSort(field, 'desc');
    });

    const head = document.querySelector('.geo-table thead');
    if (head) new MutationObserver(sync).observe(head, { attributes: true, subtree: true, attributeFilter: ['aria-sort'] });
    sync();
  }

  function ensureMapControls() {
    const header = document.querySelector('.geo-map-header');
    if (!header || header.querySelector('.geo-map-zoom')) return;

    let actions = header.querySelector('.geo-map-actions');
    if (!actions) {
      actions = document.createElement('div');
      actions.className = 'geo-map-actions';
      header.appendChild(actions);
    }

    const back = header.querySelector('#geoBack');
    if (back && back.parentElement !== actions) actions.appendChild(back);

    const controls = document.createElement('div');
    controls.className = 'geo-map-zoom';
    controls.setAttribute('role', 'group');
    controls.setAttribute('aria-label', 'Map zoom controls');
    controls.innerHTML = `
      <button id="geoZoomOut" type="button" aria-label="Zoom out" title="Zoom out">−</button>
      <button id="geoZoomReset" class="geo-map-reset" type="button" aria-label="Reset map view" title="Reset map view">Reset</button>
      <button id="geoZoomIn" type="button" aria-label="Zoom in" title="Zoom in">+</button>
    `;
    actions.appendChild(controls);

    controls.querySelector('#geoZoomIn')?.addEventListener('click', () => zoomBy(1.6));
    controls.querySelector('#geoZoomOut')?.addEventListener('click', () => zoomBy(1 / 1.6));
    controls.querySelector('#geoZoomReset')?.addEventListener('click', resetZoom);
    updateZoomControls(1, 8);
  }

  function svgSize(svg) {
    const vb = svg.viewBox?.baseVal;
    return {
      width: vb?.width || svg.clientWidth || 900,
      height: vb?.height || svg.clientHeight || 520,
    };
  }

  function updateZoomControls(scale = 1, maxScale = 8) {
    const zoomOut = document.getElementById('geoZoomOut');
    const zoomIn = document.getElementById('geoZoomIn');
    const reset = document.getElementById('geoZoomReset');
    if (zoomOut) zoomOut.disabled = scale <= 1.001;
    if (zoomIn) zoomIn.disabled = scale >= maxScale - 0.001;
    if (reset) {
      reset.disabled = scale <= 1.001;
      reset.title = scale <= 1.001 ? 'Map is fitted to view' : `Reset map view · ${Math.round(scale * 100)}%`;
    }
  }

  function zoomBy(factor) {
    if (!ACTIVE_MAP_ZOOM) return;
    const { svg, behavior } = ACTIVE_MAP_ZOOM;
    svg.interrupt().transition().duration(170).call(behavior.scaleBy, factor);
  }

  function resetZoom() {
    if (!ACTIVE_MAP_ZOOM) return;
    const { svg, behavior } = ACTIVE_MAP_ZOOM;
    svg.interrupt().transition().duration(190).call(behavior.transform, d3.zoomIdentity);
  }

  function installZoomLayer() {
    const svgNode = document.getElementById('geoMap');
    if (!svgNode || zoomInstalling) return;
    const existing = svgNode.querySelector(':scope > g.geo-map-zoom-layer');
    if (existing) return;

    const candidates = [...svgNode.children].filter((node) => {
      const tag = String(node.tagName || '').toLowerCase();
      return tag !== 'defs' && !node.classList?.contains('geo-map-zoom-layer');
    });
    if (!candidates.length) {
      ACTIVE_MAP_ZOOM = null;
      updateZoomControls(1, 8);
      return;
    }

    zoomInstalling = true;
    try {
      const layer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      layer.setAttribute('class', 'geo-map-zoom-layer');
      svgNode.insertBefore(layer, candidates[0]);
      candidates.forEach((node) => layer.appendChild(node));

      const { width, height } = svgSize(svgNode);
      const postalMode = Boolean(layer.querySelector('.postal-shape'));
      const maxScale = postalMode ? 12 : 8;
      const svg = d3.select(svgNode);
      svg.on('.zoom', null);

      const behavior = d3.zoom()
        .scaleExtent([1, maxScale])
        .extent([[0, 0], [width, height]])
        .translateExtent([[0, 0], [width, height]])
        .clickDistance(5)
        .filter((event) => {
          if (event.type === 'wheel') return true;
          if (event.type === 'mousedown') return event.button === 0;
          if (event.type.startsWith('touch')) return true;
          return !event.button;
        })
        .on('start', () => {
          hideTip();
          svgNode.classList.add('geo-map--panning');
        })
        .on('zoom', (event) => {
          layer.setAttribute('transform', event.transform.toString());
          updateZoomControls(event.transform.k, maxScale);
        })
        .on('end', (event) => {
          svgNode.classList.remove('geo-map--panning');
          updateZoomControls(event.transform.k, maxScale);
        });

      svg.call(behavior).on('dblclick.zoom', null);
      svg.call(behavior.transform, d3.zoomIdentity);
      ACTIVE_MAP_ZOOM = { svg, behavior, layer, maxScale, postalMode };
      svgNode.dataset.zoomReady = '1';
      svgNode.dataset.zoomMode = postalMode ? 'postal' : 'national';
      updateZoomControls(1, maxScale);
    } finally {
      zoomInstalling = false;
    }
  }

  function fixPostalProjection() {
    const svg = document.getElementById('geoMap');
    if (!svg) return;
    const contextNode = svg.querySelector('.geo-state-context');
    const postalNodes = [...svg.querySelectorAll('path.postal-shape')];
    if (!contextNode || !postalNodes.length) return;

    const context = contextNode.__data__;
    const features = postalNodes.map((node) => node.__data__).filter(Boolean);
    if (!context || !features.length) return;

    const { width, height } = svgSize(svg);
    const target = { type: 'FeatureCollection', features: [context] };
    // Postal drill-down covers one state only. A planar lon/lat projection is
    // deliberately used here so ring winding can never be interpreted as the
    // spherical complement of a small postal polygon.
    const projection = d3.geoIdentity().reflectY(true).fitExtent([[22, 18], [width - 22, height - 20]], target);
    const path = d3.geoPath(projection);

    contextNode.setAttribute('d', path(context) || '');
    postalNodes.forEach((node) => {
      const d = path(node.__data__);
      if (d) node.setAttribute('d', d);
    });
    svg.dataset.postalProjection = 'planar';
  }

  function hardenPostalPaths() {
    const svg = document.getElementById('geoMap');
    if (!svg) return;
    const postalNodes = [...svg.querySelectorAll('path.postal-shape')];
    if (!postalNodes.length) return;
    fixPostalProjection();

    const { width, height } = svgSize(svg);
    // Last-resort visual guard: a single postal path should never occupy nearly
    // the whole state viewport. If malformed geometry survives upstream checks,
    // suppress it instead of painting a false map.
    postalNodes.forEach((node) => {
      try {
        const box = node.getBBox();
        const coversViewport = box.width > width * 0.96 && box.height > height * 0.96;
        node.style.display = coversViewport ? 'none' : '';
        if (coversViewport) node.dataset.geometryRejected = 'viewport-complement';
      } catch (_) {
        // SVG may not be measurable during an intermediate render frame.
      }
    });
  }

  function installMapObserver() {
    const svg = document.getElementById('geoMap');
    if (!svg || svg.dataset.geometryFixObserver === '1') return;
    svg.dataset.geometryFixObserver = '1';
    let pending = false;
    const run = () => {
      pending = false;
      if (zoomInstalling) return;
      hardenPostalPaths();
      installZoomLayer();
    };
    new MutationObserver(() => {
      if (zoomInstalling || pending) return;
      pending = true;
      requestAnimationFrame(run);
    }).observe(svg, { childList: true, subtree: true, attributes: false });
    run();
  }

  function init() {
    ensureSortControls();
    ensureMapControls();
    installMapObserver();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();