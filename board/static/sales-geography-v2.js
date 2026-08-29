import { formatCount, money } from './format-core.js';

/* Sales geography v2: local SEPOMEX labels + same-origin filtered postal polygons. */
(() => {
  'use strict';
  const d3 = window.d3;
  if (!d3) return;

  const STATES_URL = '/assets/mexico-states-90a1d52.geojson';
  const STATE_META = [
    ['01', 'Aguascalientes'],
    ['02', 'Baja California'],
    ['03', 'Baja California Sur'],
    ['04', 'Campeche'],
    ['05', 'Coahuila'],
    ['06', 'Colima'],
    ['07', 'Chiapas'],
    ['08', 'Chihuahua'],
    ['09', 'Ciudad de México'],
    ['10', 'Durango'],
    ['11', 'Guanajuato'],
    ['12', 'Guerrero'],
    ['13', 'Hidalgo'],
    ['14', 'Jalisco'],
    ['15', 'Estado de México'],
    ['16', 'Michoacán'],
    ['17', 'Morelos'],
    ['18', 'Nayarit'],
    ['19', 'Nuevo León'],
    ['20', 'Oaxaca'],
    ['21', 'Puebla'],
    ['22', 'Querétaro'],
    ['23', 'Quintana Roo'],
    ['24', 'San Luis Potosí'],
    ['25', 'Sinaloa'],
    ['26', 'Sonora'],
    ['27', 'Tabasco'],
    ['28', 'Tamaulipas'],
    ['29', 'Tlaxcala'],
    ['30', 'Veracruz'],
    ['31', 'Yucatán'],
    ['32', 'Zacatecas'],
  ].map(([code, name]) => ({ code, name }));
  const META_BY_CODE = new Map(STATE_META.map((x) => [x.code, x]));
  const SORT_LABELS = {
    area: 'Area',
    sales: 'Spend',
    orders: 'Orders',
    units: 'Units',
    aov: 'AOV',
  };
  const GEO_RANGES = new Set(['30d', '90d', 'ytd', 'all']);
  const GEO_METRICS = new Set(['sales', 'orders', 'units', 'aov']);
  const RANKED_ROW_LIMIT = 20;
  const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const esc = (s) =>
    String(s ?? '').replace(
      /[&<>"']/g,
      (c) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[c],
    );
  const sortText = (value) =>
    String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase('es-MX');
  const postal = (value) =>
    String(value || '')
      .trim()
      .padStart(5, '0');

  let DATA = null;
  let LOAD_PROMISE = null;
  let RANGE = '90d';
  let METRIC = 'sales';
  let SKU = 'all';
  let SHOW_SECONDARY_PRODUCTS = false;
  let SELECTED_STATE = null;
  let SORT_FIELD = 'sales';
  let SORT_DIRECTION = 'desc';
  let SHOW_ALL_RANKED = false;
  let STATES_GEO = null;
  const POSTAL_CACHE = new Map();
  let renderToken = 0;

  function readGeographyUrlState() {
    const params = new URLSearchParams(window.location.search);
    const requestedRange = params.get('geo_range') || '90d';
    const requestedMetric = params.get('metric') || 'sales';
    const requestedState = params.get('state');
    const requestedSku = params.get('sku') || 'all';
    RANGE = GEO_RANGES.has(requestedRange) ? requestedRange : '90d';
    METRIC = GEO_METRICS.has(requestedMetric) ? requestedMetric : 'sales';
    SELECTED_STATE = META_BY_CODE.has(requestedState) ? requestedState : null;
    if (!DATA) {
      SKU = requestedSku;
      return;
    }
    const validProducts = new Set(
      (DATA.geography?.products || []).map((product) => String(product.analysis_sku || product.sku || '')),
    );
    SKU = requestedSku === 'all' || validProducts.has(requestedSku) ? requestedSku : 'all';
    const secondaryKeys = new Set(
      productGroups().secondary.map((product) => String(product.analysis_sku || product.sku || '')),
    );
    SHOW_SECONDARY_PRODUCTS = SKU !== 'all' && secondaryKeys.has(SKU);
  }

  function writeGeographyUrlState({ replace = false } = {}) {
    const url = new URL(window.location.href);
    if (RANGE === '90d') url.searchParams.delete('geo_range');
    else url.searchParams.set('geo_range', RANGE);
    if (METRIC === 'sales') url.searchParams.delete('metric');
    else url.searchParams.set('metric', METRIC);
    if (SKU === 'all') url.searchParams.delete('sku');
    else url.searchParams.set('sku', SKU);
    if (SELECTED_STATE) url.searchParams.set('state', SELECTED_STATE);
    else url.searchParams.delete('state');
    window.history[replace ? 'replaceState' : 'pushState']({}, '', url);
  }

  function syncGeographyControls() {
    document.querySelectorAll('[data-geo-range]').forEach((button) => {
      const active = button.dataset.geoRange === RANGE;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    const metric = document.getElementById('geoMetric');
    if (metric) metric.value = METRIC;
    const state = document.getElementById('geoStateSelect');
    if (state) state.value = SELECTED_STATE || 'all';
  }

  function restoreGeographyUrlState() {
    if (!DATA) return;
    readGeographyUrlState();
    initControls();
    renderAll();
  }

  function postalReferences() {
    return new Map((DATA?.geography?.postal_reference || []).map((r) => [postal(r.postal_code), r]));
  }

  function postalRef(cp) {
    return postalReferences().get(postal(cp)) || null;
  }

  function postalLabel(cp) {
    const ref = postalRef(cp);
    return ref?.municipality_name || ref?.city_name || ref?.state_name || `CP ${postal(cp)}`;
  }

  function postalDetail(cp) {
    const ref = postalRef(cp);
    if (!ref) return '';
    const settlements = (ref.settlements || []).slice(0, 3);
    const extra = (ref.settlements || []).length - settlements.length;
    const settlementCopy = settlements.join(', ') + (extra > 0 ? ` +${extra}` : '');
    return [settlementCopy, ref.municipality_name].filter(Boolean).join(' · ');
  }

  function rowDate(row) {
    const s = String(row.business_date || '').slice(0, 10);
    return s ? new Date(`${s}T12:00:00Z`) : null;
  }

  function geographyMaxDate() {
    const coverageDate = rowDate({
      business_date: DATA?.geography?.coverage?.geography_last_date || DATA?.geography?.coverage?.last_date,
    });
    if (coverageDate) return coverageDate;
    const dates = (DATA?.geography?.daily || []).map(rowDate).filter(Boolean);
    return dates.length ? d3.max(dates) : null;
  }

  function rangeBounds() {
    const maxDate = geographyMaxDate();
    if (!maxDate) return { start: null, end: null };
    if (RANGE === 'all') return { start: null, end: maxDate };
    const start =
      RANGE === 'ytd'
        ? new Date(Date.UTC(maxDate.getUTCFullYear(), 0, 1, 12))
        : d3.utcDay.offset(maxDate, -((RANGE === '30d' ? 30 : 90) - 1));
    return { start, end: maxDate };
  }

  function rowsInSelectedWindow(rows) {
    const { start, end } = rangeBounds();
    return (rows || [])
      .map((r) => ({ ...r, _date: rowDate(r) }))
      .filter((r) => r._date && (!start || r._date >= start) && (!end || r._date <= end));
  }

  function sourceRows() {
    const g = DATA?.geography || {};
    return SKU === 'all'
      ? g.daily || []
      : (g.sku_daily || []).filter((r) => String(r.analysis_sku || '') === SKU);
  }

  function rangedRows() {
    return rowsInSelectedWindow(sourceRows());
  }

  function aggregate(keyFn) {
    return d3
      .rollups(
        rangedRows(),
        (rows) => {
          const sales = d3.sum(rows, (r) => Number(r.sales || 0));
          const orders = d3.sum(rows, (r) => Number(r.orders || 0));
          const units = d3.sum(rows, (r) => Number(r.units || 0));
          return {
            sales,
            orders,
            units,
            aov: orders ? sales / orders : 0,
            rows,
          };
        },
        keyFn,
      )
      .map(([key, value]) => ({ key, ...value }));
  }

  function stateRows() {
    return aggregate((r) => String(r.state_code || '')).map((r) => {
      const meta = META_BY_CODE.get(r.key);
      return {
        ...r,
        code: meta?.code || null,
        label: meta?.name || r.rows[0]?.state_name || 'Unknown',
      };
    });
  }

  function postalRows(code) {
    return aggregate((r) => postal(r.postal_code))
      .filter((r) => !code || r.rows.some((x) => String(x.state_code || '') === code))
      .map((r) => ({ ...r, postal_code: r.key }));
  }

  function metricValue(row) {
    return Number(row?.[METRIC] || 0);
  }

  function metricLabel() {
    return { sales: 'Shopper spend', orders: 'Orders', units: 'Units', aov: 'AOV' }[METRIC] || 'Value';
  }

  function formatMetric(value) {
    return METRIC === 'sales' || METRIC === 'aov' ? money(value) : nf.format(Math.round(Number(value || 0)));
  }

  function scaleFor(rows) {
    const positive = rows.map(metricValue).filter((v) => v > 0);
    if (!positive.length) return () => 'var(--dpp-surface-subtle)';
    const high = d3.quantile(positive.sort(d3.ascending), 0.92) || d3.max(positive) || 1;
    const intensity = d3.scaleSqrt().domain([0, high]).range([18, 92]).clamp(true);
    return (value) =>
      `color-mix(in srgb, var(--dpp-data1) ${intensity(value).toFixed(1)}%, var(--dpp-surface-subtle))`;
  }

  function setText(id, value) {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  }

  function coverageCopy() {
    const c = DATA?.geography?.coverage || {};
    const pct = c.coverage_pct == null ? '—' : `${Number(c.coverage_pct).toFixed(1)}%`;
    const resolution = c.alias_resolution_pct == null ? '—' : `${Number(c.alias_resolution_pct).toFixed(1)}%`;
    if (!Number(c.orders_with_postal || 0))
      return 'Postal geography authorized · historical backfill is populating.';
    return `${formatCount(c.canonical_states, 'canonical state')} · ${formatCount(c.unmapped_orders, 'unmapped order')} · ${resolution} alias resolution across ${formatCount(c.orders_with_postal, 'postal order')} · ${formatCount(c.alias_resolved_orders, 'alias-labelled order')} resolved · ${formatCount(c.postal_codes, 'postal code')} · ${pct} postal coverage`;
  }

  function selectedWindowLabel() {
    return (
      {
        '30d': 'Last 30 days',
        '90d': 'Last 90 days',
        ytd: 'YTD',
        all: 'All history',
      }[RANGE] || RANGE
    );
  }

  function selectedProductLabel() {
    if (SKU === 'all') return 'All order evidence';
    const product = (DATA?.geography?.products || []).find((x) => String(x.analysis_sku || x.sku) === SKU);
    return product?.product || SKU;
  }

  function renderSummary() {
    const rows = SELECTED_STATE ? postalRows(SELECTED_STATE) : stateRows();
    const sales = d3.sum(rows, (r) => r.sales);
    const orders = d3.sum(rows, (r) => r.orders);
    const units = d3.sum(rows, (r) => r.units);
    const aov = orders ? sales / orders : 0;
    const rail = document.getElementById('geoKpis');
    if (!rail) return;
    rail.innerHTML = [
      ['Shopper spend', money(sales), selectedWindowLabel()],
      ['Orders', nf.format(orders), selectedProductLabel()],
      ['Units', nf.format(units), SELECTED_STATE ? META_BY_CODE.get(SELECTED_STATE)?.name || '' : 'Mexico'],
      ['AOV', money(aov), 'shopper spend / orders'],
    ]
      .map(
        ([label, value, note]) =>
          `<div class="geo-kpi"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></div>`,
      )
      .join('');
  }

  function tooltip() {
    const host = document.querySelector('.geo-map-panel');
    if (!host) return null;
    let tip = host.querySelector('.geo-tooltip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'geo-tooltip';
      host.appendChild(tip);
    }
    return tip;
  }

  function showTip(event, title, row, detail = '') {
    const tip = tooltip();
    const host = document.querySelector('.geo-map-panel');
    if (!tip || !host) return;
    tip.innerHTML = `<strong>${esc(title)}</strong>${detail ? `<span class="geo-tooltip__place">${esc(detail)}</span>` : ''}<span>${metricLabel()} · ${esc(formatMetric(metricValue(row)))}</span><span>${money(row?.sales || 0)} · ${formatCount(row?.orders, 'order')} · ${formatCount(row?.units, 'unit')}</span>`;
    const rect = host.getBoundingClientRect();
    const x = event.clientX ? event.clientX - rect.left + 12 : 18;
    const y = event.clientY ? event.clientY - rect.top + 12 : 60;
    tip.style.left = `${Math.max(10, Math.min(rect.width - 240, x))}px`;
    tip.style.top = `${Math.max(10, Math.min(rect.height - 100, y))}px`;
    tip.classList.add('show');
  }

  function hideTip() {
    tooltip()?.classList.remove('show');
  }

  async function getStatesGeo() {
    if (STATES_GEO) return STATES_GEO;
    const response = await fetch(STATES_URL, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`State map HTTP ${response.status}`);
    STATES_GEO = await response.json();
    return STATES_GEO;
  }

  async function getPostalGeo(code, rows) {
    const codes = [...new Set(rows.map((r) => postal(r.postal_code)))].sort();
    const key = `${code}:${codes.join(',')}`;
    if (POSTAL_CACHE.has(key)) return POSTAL_CACHE.get(key);
    const params = new URLSearchParams({ state: code, codes: codes.join(',') });
    const response = await fetch(`/api/geography/postal-geometry?${params}`, {
      cache: 'force-cache',
    });
    if (!response.ok) throw new Error(`Postal geometry HTTP ${response.status}`);
    const geo = await response.json();
    if (geo.error) throw new Error(geo.error);
    POSTAL_CACHE.set(key, geo);
    return geo;
  }

  function stateFeature(geo, code) {
    return (
      (geo.features || []).find(
        (feature) => String(Number(feature.properties?.state_code || 0)).padStart(2, '0') === code,
      ) || null
    );
  }

  function coordinateBounds(value, bounds = [Infinity, Infinity, -Infinity, -Infinity]) {
    if (!Array.isArray(value)) return bounds;
    if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
      const x = Number(value[0]);
      const y = Number(value[1]);
      bounds[0] = Math.min(bounds[0], x);
      bounds[1] = Math.min(bounds[1], y);
      bounds[2] = Math.max(bounds[2], x);
      bounds[3] = Math.max(bounds[3], y);
      return bounds;
    }
    value.forEach((child) => coordinateBounds(child, bounds));
    return bounds;
  }

  function featureBounds(feature) {
    const bounds = coordinateBounds(feature?.geometry?.coordinates);
    return bounds.every(Number.isFinite) ? bounds : null;
  }

  function postalFeaturesWithinState(features, context) {
    if (!context) return features || [];
    const stateBounds = featureBounds(context);
    if (!stateBounds) return features || [];
    const margin = 0.35;
    return (features || []).filter((feature) => {
      const bounds = featureBounds(feature);
      if (!bounds) return false;
      return (
        bounds[0] >= stateBounds[0] - margin &&
        bounds[1] >= stateBounds[1] - margin &&
        bounds[2] <= stateBounds[2] + margin &&
        bounds[3] <= stateBounds[3] + margin
      );
    });
  }

  function mapShell() {
    const svg = d3.select('#geoMap');
    svg.selectAll('*').remove();
    const node = svg.node();
    const host = node?.parentElement;
    const width = Math.max(280, Math.floor(host?.clientWidth || 900));
    const height = width < 700 ? Math.max(360, Math.round(width * 0.72)) : 520;
    svg.attr('viewBox', `0 0 ${width} ${height}`).attr('role', 'img');
    return { svg, width, height };
  }

  async function renderNationalMap(token) {
    const shell = mapShell();
    setText('geoMapStatus', 'Mexico · click a state to inspect postal codes');
    const geo = await getStatesGeo();
    if (token !== renderToken) return;
    const rows = stateRows();
    const byCode = new Map(rows.filter((r) => r.code).map((r) => [r.code, r]));
    const fill = scaleFor(rows);
    const projection = d3.geoMercator().fitExtent(
      [
        [22, 18],
        [shell.width - 22, shell.height - 20],
      ],
      geo,
    );
    const path = d3.geoPath(projection);
    shell.svg.attr('role', 'group').attr('aria-label', `Mexico states by ${metricLabel()}`);
    shell.svg
      .append('g')
      .selectAll('path')
      .data(geo.features || [])
      .join('path')
      .attr('class', 'geo-shape state-shape')
      .attr('d', path)
      .attr('fill', (feature) => {
        const code = String(Number(feature.properties?.state_code || 0)).padStart(2, '0');
        return byCode.has(code) ? fill(metricValue(byCode.get(code))) : 'var(--dpp-surface-subtle)';
      })
      .attr('tabindex', 0)
      .attr('role', 'button')
      .attr('aria-label', (feature) => {
        const code = String(Number(feature.properties?.state_code || 0)).padStart(2, '0');
        const row = byCode.get(code);
        const name = META_BY_CODE.get(code)?.name || feature.properties?.state_name || code;
        return `${name}: ${formatMetric(metricValue(row))} ${metricLabel()}. Open postal evidence.`;
      })
      .on('pointerenter pointermove focus', function (event, feature) {
        const code = String(Number(feature.properties?.state_code || 0)).padStart(2, '0');
        const row = byCode.get(code) || {
          sales: 0,
          orders: 0,
          units: 0,
          aov: 0,
        };
        showTip(event, META_BY_CODE.get(code)?.name || feature.properties?.state_name || code, row);
      })
      .on('pointerleave blur', hideTip)
      .on('click keydown', function (event, feature) {
        if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
        if (event.type === 'keydown') event.preventDefault();
        selectState(String(Number(feature.properties?.state_code || 0)).padStart(2, '0'));
      });
  }

  async function renderPostalMap(code, token) {
    const shell = mapShell();
    const meta = META_BY_CODE.get(code);
    const rows = postalRows(code);
    setText('geoMapStatus', `${meta?.name || 'State'} · loading postal polygons`);
    const [states, geo] = await Promise.all([getStatesGeo(), getPostalGeo(code, rows)]);
    if (token !== renderToken) return;
    const context = stateFeature(states, code);
    const features = postalFeaturesWithinState(geo.features || [], context);
    const renderGeo = { type: 'FeatureCollection', features };
    const fitTarget = context ? { type: 'FeatureCollection', features: [context] } : renderGeo;
    const projection = d3.geoMercator().fitExtent(
      [
        [22, 18],
        [shell.width - 22, shell.height - 20],
      ],
      fitTarget,
    );
    const path = d3.geoPath(projection);
    if (context) shell.svg.append('path').datum(context).attr('class', 'geo-state-context').attr('d', path);

    const byPostal = new Map(rows.map((r) => [postal(r.postal_code), r]));
    const fill = scaleFor(rows);
    shell.svg
      .append('g')
      .selectAll('path')
      .data(features)
      .join('path')
      .attr('class', 'geo-shape postal-shape')
      .attr('d', path)
      .attr('fill', (feature) => {
        const cp = postal(feature.properties?.d_codigo);
        return fill(metricValue(byPostal.get(cp)));
      })
      .attr('tabindex', -1)
      .attr('aria-hidden', 'true')
      .on('pointerenter pointermove', function (event, feature) {
        const cp = postal(feature.properties?.d_codigo);
        const row = byPostal.get(cp) || {
          sales: 0,
          orders: 0,
          units: 0,
          aov: 0,
        };
        showTip(event, `CP ${cp} · ${postalLabel(cp)}`, row, postalDetail(cp));
      })
      .on('pointerleave', hideTip);

    const renderedCodes = new Set(features.map((feature) => postal(feature.properties?.d_codigo))).size;
    const requested = Number(geo.requested_codes || rows.length);
    const rejected = Math.max(0, Number(geo.matched_codes || 0) - renderedCodes);
    const suffix = rejected ? ` · ${rejected} rejected outside state bounds` : '';
    setText(
      'geoMapStatus',
      `${meta?.name || 'State'} · ${renderedCodes}/${requested} active postal polygons mapped${suffix}`,
    );
  }

  function areaSortValue(row) {
    if (SELECTED_STATE) return `${postalLabel(row.postal_code)} ${postal(row.postal_code)}`;
    return row.label || row.code || '';
  }

  function sortedRankRows() {
    const rows = SELECTED_STATE ? postalRows(SELECTED_STATE) : stateRows();
    return rows.slice().sort((a, b) => {
      let comparison;
      if (SORT_FIELD === 'area')
        comparison = d3.ascending(sortText(areaSortValue(a)), sortText(areaSortValue(b)));
      else comparison = d3.ascending(Number(a?.[SORT_FIELD] || 0), Number(b?.[SORT_FIELD] || 0));
      if (SORT_DIRECTION === 'desc') comparison *= -1;
      if (comparison) return comparison;
      return d3.ascending(sortText(areaSortValue(a)), sortText(areaSortValue(b)));
    });
  }

  function updateSortUi(totalRows, visibleRows) {
    document.querySelectorAll('.geo-table th[data-geo-sort]').forEach((header) => {
      const active = header.dataset.geoSort === SORT_FIELD;
      header.setAttribute(
        'aria-sort',
        active ? (SORT_DIRECTION === 'desc' ? 'descending' : 'ascending') : 'none',
      );
    });
    const direction = SORT_DIRECTION === 'desc' ? '↓' : '↑';
    const noun = SELECTED_STATE ? 'postal codes' : 'states';
    const countCopy =
      visibleRows === totalRows ? `Showing all ${totalRows}` : `Showing ${visibleRows} of ${totalRows}`;
    setText(
      'geoSortStatus',
      `${countCopy} ${noun} · sorted by ${SORT_LABELS[SORT_FIELD] || SORT_FIELD} ${direction}`,
    );
  }

  function renderRanked() {
    const out = document.getElementById('geoRankedRows');
    const title = document.getElementById('geoRankedTitle');
    if (!out || !title) return;
    const rows = sortedRankRows();
    const visibleRows = SHOW_ALL_RANKED ? rows : rows.slice(0, RANKED_ROW_LIMIT);
    title.textContent = SELECTED_STATE
      ? `Postal codes · ${META_BY_CODE.get(SELECTED_STATE)?.name || ''}`
      : 'States';
    updateSortUi(rows.length, visibleRows.length);
    const showAll = document.getElementById('geoShowAll');
    if (showAll) {
      const limited = rows.length > RANKED_ROW_LIMIT;
      showAll.hidden = !limited;
      showAll.setAttribute('aria-expanded', String(limited && SHOW_ALL_RANKED));
      showAll.textContent = SHOW_ALL_RANKED ? `Show top ${RANKED_ROW_LIMIT}` : `Show all ${rows.length}`;
    }
    out.innerHTML = visibleRows
      .map((r) => {
        const click = !SELECTED_STATE && r.code ? ` data-state="${r.code}" tabindex="0" role="button"` : '';
        const area = SELECTED_STATE
          ? `<strong>CP ${esc(r.postal_code)} · ${esc(postalLabel(r.postal_code))}</strong><small>${esc(postalDetail(r.postal_code))}</small>`
          : `<strong>${esc(r.label)}</strong>`;
        return `<tr${click}><td class="geo-area-cell">${area}</td><td class="num" data-value="${Number(r.sales || 0)}">${money(r.sales)}</td><td class="num" data-value="${Number(r.orders || 0)}">${nf.format(r.orders)}</td><td class="num" data-value="${Number(r.units || 0)}">${nf.format(r.units)}</td><td class="num" data-value="${Number(r.aov || 0)}">${money(r.aov)}</td></tr>`;
      })
      .join('');
    out.querySelectorAll('[data-state]').forEach((row) => {
      const go = () => selectState(row.dataset.state);
      row.addEventListener('click', go);
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          go();
        }
      });
    });
  }

  async function renderMap() {
    const token = ++renderToken;
    try {
      await (SELECTED_STATE ? renderPostalMap(SELECTED_STATE, token) : renderNationalMap(token));
    } catch (error) {
      if (token !== renderToken) return;
      console.error(error);
      const shell = mapShell();
      setText(
        'geoMapStatus',
        SELECTED_STATE
          ? 'Postal geometry unavailable · ranked demand remains available'
          : 'Map geometry unavailable · ranked geography remains available',
      );
      shell.svg
        .append('text')
        .attr('x', shell.width / 2)
        .attr('y', shell.height / 2)
        .attr('text-anchor', 'middle')
        .attr('class', 'geo-map-fallback')
        .text('Map geometry unavailable');
    }
  }

  function renderAll() {
    if (!DATA) return;
    const geography = document.getElementById('geography');
    if (geography) geography.dataset.geoMetric = METRIC;
    setText('geoCoverage', coverageCopy());
    const back = document.getElementById('geoBack');
    if (back) back.hidden = !SELECTED_STATE;
    const state = document.getElementById('geoStateSelect');
    if (state) state.value = SELECTED_STATE || 'all';
    renderSummary();
    renderRanked();
    renderMap();
  }

  function selectState(code, { updateUrl = true } = {}) {
    SELECTED_STATE = code && code !== 'all' ? code : null;
    SHOW_ALL_RANKED = false;
    if (updateUrl) writeGeographyUrlState();
    renderAll();
  }

  function productGroups() {
    const evidence = new Set(
      rowsInSelectedWindow(DATA?.geography?.sku_daily || [])
        .map((row) => String(row.analysis_sku || ''))
        .filter(Boolean),
    );
    const products = (DATA?.geography?.products || [])
      .slice()
      .sort((a, b) => String(a.product || a.sku).localeCompare(String(b.product || b.sku), 'es-MX'));
    const primary = products.filter(
      (product) =>
        product.is_current_offer &&
        product.is_active_offer &&
        evidence.has(String(product.analysis_sku || product.sku || '')),
    );
    const primaryKeys = new Set(primary.map((product) => String(product.analysis_sku || product.sku)));
    const secondary = products.filter(
      (product) => !primaryKeys.has(String(product.analysis_sku || product.sku)),
    );
    return { primary, secondary, evidence };
  }

  function productOption(product, secondary = false) {
    const sku = String(product.analysis_sku || product.sku || '');
    let suffix = '';
    if (secondary) {
      if (!product.is_current_offer) suffix = ' · Historical transactions';
      else if (!product.is_active_offer) suffix = ` · ${product.status || 'Inactive offer'}`;
      else suffix = ` · No ${selectedWindowLabel()} evidence`;
    }
    return `<option value="${esc(sku)}">${esc(product.product || sku)} · ${esc(sku)}${esc(suffix)}</option>`;
  }

  function renderProductControl() {
    const product = document.getElementById('geoProduct');
    const secondaryButton = document.getElementById('geoSecondaryProducts');
    const { primary, secondary } = productGroups();
    const visible = SHOW_SECONDARY_PRODUCTS ? [...primary, ...secondary] : primary;
    const visibleKeys = new Set(visible.map((item) => String(item.analysis_sku || item.sku)));
    if (SKU !== 'all' && !visibleKeys.has(SKU)) SKU = 'all';

    if (product) {
      const primaryOptions = primary.map((item) => productOption(item)).join('');
      const secondaryOptions = SHOW_SECONDARY_PRODUCTS
        ? `<optgroup label="Historical, inactive, or no evidence">${secondary.map((item) => productOption(item, true)).join('')}</optgroup>`
        : '';
      product.innerHTML = `<option value="all">All order evidence</option><optgroup label="Current offers with ${esc(selectedWindowLabel())} evidence">${primaryOptions}</optgroup>${secondaryOptions}`;
      product.value = SKU;
    }
    if (secondaryButton) {
      secondaryButton.hidden = secondary.length === 0;
      secondaryButton.setAttribute('aria-expanded', String(SHOW_SECONDARY_PRODUCTS));
      secondaryButton.textContent = SHOW_SECONDARY_PRODUCTS
        ? 'Hide secondary products'
        : `Show secondary products (${secondary.length})`;
    }
    setText(
      'geoProductScope',
      `${primary.length} current products with ${selectedWindowLabel()} evidence · ${secondary.length} historical, inactive, or no-evidence products ${SHOW_SECONDARY_PRODUCTS ? 'shown' : 'hidden'}`,
    );
  }

  function initControls() {
    const state = document.getElementById('geoStateSelect');
    if (state) {
      state.innerHTML = `<option value="all">Mexico</option>${STATE_META.map((m) => `<option value="${m.code}">${esc(m.name)}</option>`).join('')}`;
    }
    renderProductControl();
    syncGeographyControls();
  }

  function bind() {
    document.getElementById('geoRange')?.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-geo-range]');
      if (!button || button.dataset.geoRange === RANGE) return;
      RANGE = button.dataset.geoRange;
      SHOW_ALL_RANKED = false;
      renderProductControl();
      syncGeographyControls();
      writeGeographyUrlState();
      renderAll();
    });
    document.getElementById('geoMetric')?.addEventListener('change', (event) => {
      METRIC = event.target.value;
      writeGeographyUrlState();
      renderAll();
    });
    document.getElementById('geoProduct')?.addEventListener('change', (event) => {
      SKU = event.target.value;
      SHOW_ALL_RANKED = false;
      writeGeographyUrlState();
      renderAll();
    });
    document.getElementById('geoSecondaryProducts')?.addEventListener('click', () => {
      const previousSku = SKU;
      SHOW_SECONDARY_PRODUCTS = !SHOW_SECONDARY_PRODUCTS;
      SHOW_ALL_RANKED = false;
      renderProductControl();
      if (SKU !== previousSku) writeGeographyUrlState();
      renderAll();
    });
    document
      .getElementById('geoStateSelect')
      ?.addEventListener('change', (event) => selectState(event.target.value));
    document.getElementById('geoBack')?.addEventListener('click', () => selectState(null));
    document.getElementById('geoShowAll')?.addEventListener('click', () => {
      SHOW_ALL_RANKED = !SHOW_ALL_RANKED;
      renderRanked();
    });
    document.querySelector('.geo-table thead')?.addEventListener('click', (event) => {
      const header = event.target.closest('th[data-geo-sort]');
      if (!header) return;
      const field = header.dataset.geoSort;
      if (!SORT_LABELS[field]) return;
      if (SORT_FIELD === field) SORT_DIRECTION = SORT_DIRECTION === 'desc' ? 'asc' : 'desc';
      else {
        SORT_FIELD = field;
        SORT_DIRECTION = field === 'area' ? 'asc' : 'desc';
      }
      renderRanked();
    });
    document.querySelector('[data-view="geography"]')?.addEventListener('click', () => {
      if (DATA) renderAll();
      else load();
    });
    window.addEventListener('dpp:sales-view', (event) => {
      if (event.detail?.view !== 'geography') return;
      if (DATA) renderAll();
      else load();
    });
    window.addEventListener('popstate', restoreGeographyUrlState);
    let timer;
    window.addEventListener(
      'resize',
      () => {
        if (!document.getElementById('geography')?.classList.contains('active')) return;
        clearTimeout(timer);
        timer = setTimeout(renderMap, 160);
      },
      { passive: true },
    );
  }

  function load() {
    if (LOAD_PROMISE) return LOAD_PROMISE;
    LOAD_PROMISE = (async () => {
      try {
        if (!window.DPPDataCache?.fetchJson) throw new Error('DPP data cache unavailable');
        DATA = await window.DPPDataCache.fetchJson('/api/sales/geography');
        readGeographyUrlState();
        initControls();
        renderAll();
        writeGeographyUrlState({ replace: true });
      } catch (error) {
        console.error(error);
        setText('geoCoverage', 'Geography data unavailable');
        setText('geoMapStatus', 'Geography data unavailable');
      }
    })().finally(() => {
      LOAD_PROMISE = null;
    });
    return LOAD_PROMISE;
  }

  bind();
  if (new URLSearchParams(window.location.search).get('view') === 'geography') load();
})();

/* Consolidated geography hardening: explicit sorting and local map zoom. */
(() => {
  'use strict';
  const d3 = window.d3;
  if (!d3) return;

  let ACTIVE_MAP_ZOOM = null;
  let zoomInstalling = false;

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
      const active = document.querySelector(
        '.geo-table th[data-geo-sort][aria-sort="ascending"], .geo-table th[data-geo-sort][aria-sort="descending"]',
      );
      return {
        field: active?.dataset.geoSort || 'sales',
        direction: active?.getAttribute('aria-sort') === 'ascending' ? 'asc' : 'desc',
      };
    }

    function sync() {
      const current = activeSort();
      select.value = current.field;
      direction.textContent = current.direction === 'asc' ? '↑' : '↓';
      direction.setAttribute(
        'aria-label',
        `Sort ${current.direction === 'asc' ? 'descending' : 'ascending'}`,
      );
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
    if (head)
      new MutationObserver(sync).observe(head, {
        attributes: true,
        subtree: true,
        attributeFilter: ['aria-sort'],
      });
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

      const behavior = d3
        .zoom()
        .scaleExtent([1, maxScale])
        .extent([
          [0, 0],
          [width, height],
        ])
        .translateExtent([
          [0, 0],
          [width, height],
        ])
        .clickDistance(5)
        .filter((event) => {
          if (event.type === 'wheel') return true;
          if (event.type === 'mousedown') return event.button === 0;
          if (event.type.startsWith('touch')) return true;
          return !event.button;
        })
        .on('start', () => {
          window.hideTip?.();
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
    const projection = d3
      .geoIdentity()
      .reflectY(true)
      .fitExtent(
        [
          [22, 18],
          [width - 22, height - 20],
        ],
        target,
      );
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
      } catch {
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
