/* Sales geography v2: local SEPOMEX labels + same-origin filtered postal polygons. */
(() => {
  'use strict';
  const d3 = window.d3;
  if (!d3) return;

  const STATES_URL = 'https://raw.githubusercontent.com/strotgen/mexico-leaflet/master/states.geojson';
  const STATE_META = [
    ['01', 'Aguascalientes', ['aguascalientes', 'ags']],
    ['02', 'Baja California', ['baja california', 'bc']],
    ['03', 'Baja California Sur', ['baja california sur', 'bcs']],
    ['04', 'Campeche', ['campeche', 'camp']],
    ['05', 'Coahuila', ['coahuila', 'coahuila de zaragoza', 'coah']],
    ['06', 'Colima', ['colima', 'col']],
    ['07', 'Chiapas', ['chiapas', 'chis']],
    ['08', 'Chihuahua', ['chihuahua', 'chih']],
    ['09', 'Ciudad de México', ['ciudad de mexico', 'cdmx', 'distrito federal', 'df']],
    ['10', 'Durango', ['durango', 'dgo']],
    ['11', 'Guanajuato', ['guanajuato', 'gto']],
    ['12', 'Guerrero', ['guerrero', 'gro']],
    ['13', 'Hidalgo', ['hidalgo', 'hgo']],
    ['14', 'Jalisco', ['jalisco', 'jal']],
    ['15', 'Estado de México', ['estado de mexico', 'mexico', 'edomex', 'mex']],
    ['16', 'Michoacán', ['michoacan', 'michoacan de ocampo', 'mich']],
    ['17', 'Morelos', ['morelos', 'mor']],
    ['18', 'Nayarit', ['nayarit', 'nay']],
    ['19', 'Nuevo León', ['nuevo leon', 'nl', 'n l']],
    ['20', 'Oaxaca', ['oaxaca', 'oax']],
    ['21', 'Puebla', ['puebla', 'pue']],
    ['22', 'Querétaro', ['queretaro', 'queretaro de arteaga', 'qro']],
    ['23', 'Quintana Roo', ['quintana roo', 'qroo', 'q roo']],
    ['24', 'San Luis Potosí', ['san luis potosi', 'slp']],
    ['25', 'Sinaloa', ['sinaloa', 'sin']],
    ['26', 'Sonora', ['sonora', 'son']],
    ['27', 'Tabasco', ['tabasco', 'tab']],
    ['28', 'Tamaulipas', ['tamaulipas', 'tamps', 'tmps']],
    ['29', 'Tlaxcala', ['tlaxcala', 'tlax']],
    ['30', 'Veracruz', ['veracruz', 'veracruz de ignacio de la llave', 'ver']],
    ['31', 'Yucatán', ['yucatan', 'yuc']],
    ['32', 'Zacatecas', ['zacatecas', 'zac']],
  ].map(([code, name, aliases]) => ({ code, name, aliases }));
  const META_BY_CODE = new Map(STATE_META.map((x) => [x.code, x]));
  const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const money = (v) => '$' + nf.format(Math.round(Number(v || 0)));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const normalize = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const postal = (value) => String(value || '').trim().padStart(5, '0');

  let DATA = null;
  let RANGE = '90d';
  let METRIC = 'sales';
  let SKU = 'all';
  let SELECTED_STATE = null;
  let STATES_GEO = null;
  const POSTAL_CACHE = new Map();
  let renderToken = 0;

  function stateMeta(raw) {
    const n = normalize(raw);
    if (!n) return null;
    return STATE_META.find((m) => m.aliases.some((a) => n === normalize(a))) || null;
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

  function sourceRows() {
    const g = DATA?.geography || {};
    return SKU === 'all' ? g.daily || [] : (g.sku_daily || []).filter((r) => String(r.seller_sku || '') === SKU);
  }

  function rangedRows() {
    const rows = sourceRows().map((r) => ({ ...r, _date: rowDate(r) })).filter((r) => r._date);
    if (!rows.length || RANGE === 'all') return rows;
    const maxDate = d3.max(rows, (r) => r._date);
    if (!maxDate) return rows;
    let start;
    if (RANGE === 'ytd') start = new Date(Date.UTC(maxDate.getUTCFullYear(), 0, 1, 12));
    else start = d3.utcDay.offset(maxDate, -((RANGE === '30d' ? 30 : 90) - 1));
    return rows.filter((r) => r._date >= start && r._date <= maxDate);
  }

  function aggregate(keyFn) {
    return d3.rollups(
      rangedRows(),
      (rows) => {
        const sales = d3.sum(rows, (r) => Number(r.sales || 0));
        const orders = d3.sum(rows, (r) => Number(r.orders || 0));
        const units = d3.sum(rows, (r) => Number(r.units || 0));
        return { sales, orders, units, aov: orders ? sales / orders : 0, rows };
      },
      keyFn,
    ).map(([key, value]) => ({ key, ...value }));
  }

  function stateRows() {
    return aggregate((r) => stateMeta(r.state_or_region)?.code || `raw:${String(r.state_or_region || 'Unknown')}`).map((r) => {
      const meta = META_BY_CODE.get(r.key);
      const raw = r.rows.find((x) => x.state_or_region)?.state_or_region;
      return { ...r, code: meta?.code || null, label: meta?.name || raw || 'Unknown' };
    });
  }

  function postalRows(code) {
    return aggregate((r) => postal(r.postal_code))
      .filter((r) => !code || r.rows.some((x) => stateMeta(x.state_or_region)?.code === code))
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
    if (!positive.length) return () => '#eeeae2';
    const high = d3.quantile(positive.sort(d3.ascending), 0.92) || d3.max(positive) || 1;
    return d3.scaleSequentialSqrt().domain([0, high]).interpolator(d3.interpolateOranges).clamp(true);
  }

  function setText(id, value) {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  }

  function coverageCopy() {
    const c = DATA?.geography?.coverage || {};
    const pct = c.coverage_pct == null ? '—' : `${Number(c.coverage_pct).toFixed(1)}%`;
    if (!Number(c.orders_with_postal || 0)) return 'Postal geography authorized · historical backfill is populating.';
    return `${nf.format(c.orders_with_postal)} of ${nf.format(c.orders_total)} orders geocoded · ${pct} coverage · ${nf.format(c.postal_codes || 0)} postal codes · ${nf.format(c.states || 0)} states`;
  }

  function selectedWindowLabel() {
    return { '30d': 'Last 30 days', '90d': 'Last 90 days', ytd: 'YTD', all: 'All history' }[RANGE] || RANGE;
  }

  function selectedProductLabel() {
    if (SKU === 'all') return 'All products';
    const product = (DATA?.geography?.products || []).find((x) => String(x.sku) === SKU);
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
    ].map(([label, value, note]) => `<div class="geo-kpi"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></div>`).join('');
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
    tip.innerHTML = `<strong>${esc(title)}</strong>${detail ? `<span class="geo-tooltip__place">${esc(detail)}</span>` : ''}<span>${metricLabel()} · ${esc(formatMetric(metricValue(row)))}</span><span>${money(row?.sales || 0)} · ${nf.format(row?.orders || 0)} orders · ${nf.format(row?.units || 0)} units</span>`;
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
    const response = await fetch(`/api/geography/postal-geometry?${params}`, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`Postal geometry HTTP ${response.status}`);
    const geo = await response.json();
    if (geo.error) throw new Error(geo.error);
    POSTAL_CACHE.set(key, geo);
    return geo;
  }

  function stateFeature(geo, code) {
    return (geo.features || []).find((feature) => String(Number(feature.properties?.state_code || 0)).padStart(2, '0') === code) || null;
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
    const projection = d3.geoMercator().fitExtent([[22, 18], [shell.width - 22, shell.height - 20]], geo);
    const path = d3.geoPath(projection);
    shell.svg.append('g').selectAll('path').data(geo.features || []).join('path')
      .attr('class', 'geo-shape state-shape')
      .attr('d', path)
      .attr('fill', (feature) => {
        const code = String(Number(feature.properties?.state_code || 0)).padStart(2, '0');
        return byCode.has(code) ? fill(metricValue(byCode.get(code))) : '#eeeae2';
      })
      .attr('tabindex', 0)
      .on('pointerenter pointermove focus', function (event, feature) {
        const code = String(Number(feature.properties?.state_code || 0)).padStart(2, '0');
        const row = byCode.get(code) || { sales: 0, orders: 0, units: 0, aov: 0 };
        showTip(event, META_BY_CODE.get(code)?.name || feature.properties?.state_name || code, row);
      })
      .on('pointerleave blur', hideTip)
      .on('click keydown', function (event, feature) {
        if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
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
    const fitTarget = context ? { type: 'FeatureCollection', features: [context] } : geo;
    const projection = d3.geoMercator().fitExtent([[22, 18], [shell.width - 22, shell.height - 20]], fitTarget);
    const path = d3.geoPath(projection);
    if (context) shell.svg.append('path').datum(context).attr('class', 'geo-state-context').attr('d', path);

    const byPostal = new Map(rows.map((r) => [postal(r.postal_code), r]));
    const fill = scaleFor(rows);
    shell.svg.append('g').selectAll('path').data(geo.features || []).join('path')
      .attr('class', 'geo-shape postal-shape')
      .attr('d', path)
      .attr('fill', (feature) => {
        const cp = postal(feature.properties?.d_codigo);
        return fill(metricValue(byPostal.get(cp)));
      })
      .attr('tabindex', 0)
      .on('pointerenter pointermove focus', function (event, feature) {
        const cp = postal(feature.properties?.d_codigo);
        const row = byPostal.get(cp) || { sales: 0, orders: 0, units: 0, aov: 0 };
        showTip(event, `CP ${cp} · ${postalLabel(cp)}`, row, postalDetail(cp));
      })
      .on('pointerleave blur', hideTip);

    const matched = Number(geo.matched_codes || 0);
    const requested = Number(geo.requested_codes || rows.length);
    setText('geoMapStatus', `${meta?.name || 'State'} · ${matched}/${requested} active postal polygons mapped`);
  }

  function renderRanked() {
    const out = document.getElementById('geoRankedRows');
    const title = document.getElementById('geoRankedTitle');
    if (!out || !title) return;
    const rows = (SELECTED_STATE ? postalRows(SELECTED_STATE) : stateRows()).sort((a, b) => d3.descending(metricValue(a), metricValue(b)));
    title.textContent = SELECTED_STATE ? `Top postal codes · ${META_BY_CODE.get(SELECTED_STATE)?.name || ''}` : 'Top states';
    out.innerHTML = rows.slice(0, 20).map((r) => {
      const click = !SELECTED_STATE && r.code ? ` data-state="${r.code}" tabindex="0" role="button"` : '';
      const area = SELECTED_STATE
        ? `<strong>CP ${esc(r.postal_code)}</strong><small>${esc(postalDetail(r.postal_code) || postalLabel(r.postal_code))}</small>`
        : `<strong>${esc(r.label)}</strong>`;
      return `<tr${click}><td class="geo-area-cell">${area}</td><td class="num">${money(r.sales)}</td><td class="num">${nf.format(r.orders)}</td><td class="num">${nf.format(r.units)}</td><td class="num">${money(r.aov)}</td></tr>`;
    }).join('');
    out.querySelectorAll('[data-state]').forEach((row) => {
      const go = () => selectState(row.dataset.state);
      row.addEventListener('click', go);
      row.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') go(); });
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
      setText('geoMapStatus', SELECTED_STATE ? 'Postal geometry unavailable · ranked demand remains available' : 'Map geometry unavailable · ranked geography remains available');
      shell.svg.append('text').attr('x', shell.width / 2).attr('y', shell.height / 2).attr('text-anchor', 'middle').attr('class', 'geo-map-fallback').text('Map geometry unavailable');
    }
  }

  function renderAll() {
    if (!DATA) return;
    setText('geoCoverage', coverageCopy());
    const back = document.getElementById('geoBack');
    if (back) back.hidden = !SELECTED_STATE;
    const state = document.getElementById('geoStateSelect');
    if (state) state.value = SELECTED_STATE || 'all';
    renderSummary();
    renderRanked();
    renderMap();
  }

  function selectState(code) {
    SELECTED_STATE = code && code !== 'all' ? code : null;
    renderAll();
  }

  function initControls() {
    const product = document.getElementById('geoProduct');
    if (product) {
      const products = (DATA?.geography?.products || []).slice().sort((a, b) => String(a.product || a.sku).localeCompare(String(b.product || b.sku)));
      product.innerHTML = `<option value="all">All products</option>${products.map((p) => `<option value="${esc(p.sku)}">${esc(p.product || p.sku)} · ${esc(p.sku)}</option>`).join('')}`;
      product.value = SKU;
    }
    const state = document.getElementById('geoStateSelect');
    if (state) {
      state.innerHTML = `<option value="all">Mexico</option>${STATE_META.map((m) => `<option value="${m.code}">${esc(m.name)}</option>`).join('')}`;
      state.value = SELECTED_STATE || 'all';
    }
  }

  function bind() {
    document.getElementById('geoRange')?.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-geo-range]');
      if (!button) return;
      RANGE = button.dataset.geoRange;
      document.querySelectorAll('[data-geo-range]').forEach((x) => x.classList.toggle('active', x === button));
      renderAll();
    });
    document.getElementById('geoMetric')?.addEventListener('change', (event) => { METRIC = event.target.value; renderAll(); });
    document.getElementById('geoProduct')?.addEventListener('change', (event) => { SKU = event.target.value; renderAll(); });
    document.getElementById('geoStateSelect')?.addEventListener('change', (event) => selectState(event.target.value));
    document.getElementById('geoBack')?.addEventListener('click', () => selectState(null));
    document.querySelector('[data-view="geography"]')?.addEventListener('click', () => { if (DATA) renderAll(); else load(); });
    let timer;
    window.addEventListener('resize', () => {
      if (!document.getElementById('geography')?.classList.contains('active')) return;
      clearTimeout(timer);
      timer = setTimeout(renderMap, 160);
    }, { passive: true });
  }

  async function load() {
    try {
      const response = await fetch('/api/sales', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      DATA = await response.json();
      initControls();
      renderAll();
    } catch (error) {
      console.error(error);
      setText('geoCoverage', 'Geography data unavailable');
      setText('geoMapStatus', 'Geography data unavailable');
    }
  }

  bind();
})();
