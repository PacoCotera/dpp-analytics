/* Geography rendering hardening: planar postal projection + explicit sort controls. */
(() => {
  'use strict';
  const d3 = window.d3;
  if (!d3) return;

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
    .geo-map { overflow:hidden !important; }
    @media (max-width:720px) {
      .geo-ranked-header { align-items:flex-start; flex-direction:column; }
      .geo-sort-controls { width:100%; justify-content:flex-start; }
      .geo-sort-control { flex:1; }
      .geo-sort-control select { width:100%; }
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

  function svgSize(svg) {
    const vb = svg.viewBox?.baseVal;
    return {
      width: vb?.width || svg.clientWidth || 900,
      height: vb?.height || svg.clientHeight || 520,
    };
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
      hardenPostalPaths();
    };
    new MutationObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(run);
    }).observe(svg, { childList: true, subtree: true, attributes: false });
    hardenPostalPaths();
  }

  function init() {
    ensureSortControls();
    installMapObserver();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
