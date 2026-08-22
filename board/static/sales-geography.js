/* Sales geography: privacy-minimized Orders demand by Mexican state and postal code. */
(() => {
  'use strict';
  const d3 = window.d3;
  if (!d3) return;

  const STATES_URL = 'https://raw.githubusercontent.com/strotgen/mexico-leaflet/master/states.geojson';
  const POSTAL_BASE = 'https://raw.githubusercontent.com/open-mexico/mexico-geojson/main/';
  const STATE_META = [
    ['01', 'Aguascalientes', '01-Ags.geojson', ['aguascalientes', 'ags']],
    ['02', 'Baja California', '02-Bc.geojson', ['baja california', 'bc']],
    ['03', 'Baja California Sur', '03-Bcs.geojson', ['baja california sur', 'bcs']],
    ['04', 'Campeche', '04-Camp.geojson', ['campeche', 'camp']],
    ['05', 'Coahuila', '05-Coah.geojson', ['coahuila', 'coahuila de zaragoza', 'coah']],
    ['06', 'Colima', '06-Col.geojson', ['colima', 'col']],
    ['07', 'Chiapas', '07-Chis.geojson', ['chiapas', 'chis']],
    ['08', 'Chihuahua', '08-Chih.geojson', ['chihuahua', 'chih']],
    ['09', 'Ciudad de México', '09-Cdmx.geojson', ['ciudad de mexico', 'cdmx', 'distrito federal', 'df']],
    ['10', 'Durango', '10-Dgo.geojson', ['durango', 'dgo']],
    ['11', 'Guanajuato', '11-Gto.geojson', ['guanajuato', 'gto']],
    ['12', 'Guerrero', '12-Gro.geojson', ['guerrero', 'gro']],
    ['13', 'Hidalgo', '13-Hgo.geojson', ['hidalgo', 'hgo']],
    ['14', 'Jalisco', '14-Jal.geojson', ['jalisco', 'jal']],
    ['15', 'Estado de México', '15-Mex.geojson', ['estado de mexico', 'mexico', 'edomex', 'mex']],
    ['16', 'Michoacán', '16-Mich.geojson', ['michoacan', 'michoacan de ocampo', 'mich']],
    ['17', 'Morelos', '17-Mor.geojson', ['morelos', 'mor']],
    ['18', 'Nayarit', '18-Nay.geojson', ['nayarit', 'nay']],
    ['19', 'Nuevo León', '19-NL.geojson', ['nuevo leon', 'nl', 'n l']],
    ['20', 'Oaxaca', '20-Oax.geojson', ['oaxaca', 'oax']],
    ['21', 'Puebla', '21-Pue.geojson', ['puebla', 'pue']],
    ['22', 'Querétaro', '22-Qro.geojson', ['queretaro', 'queretaro de arteaga', 'qro']],
    ['23', 'Quintana Roo', '23-Qroo.geojson', ['quintana roo', 'qroo', 'q roo']],
    ['24', 'San Luis Potosí', '24-SLP.geojson', ['san luis potosi', 'slp']],
    ['25', 'Sinaloa', '25-Sin.geojson', ['sinaloa', 'sin']],
    ['26', 'Sonora', '26-Son.geojson', ['sonora', 'son']],
    ['27', 'Tabasco', '27-Tab.geojson', ['tabasco', 'tab']],
    ['28', 'Tamaulipas', '28-Tmps.geojson', ['tamaulipas', 'tamps', 'tmps']],
    ['29', 'Tlaxcala', '29-Tlax.geojson', ['tlaxcala', 'tlax']],
    ['30', 'Veracruz', '30-Ver.geojson', ['veracruz', 'veracruz de ignacio de la llave', 'ver']],
    ['31', 'Yucatán', '31-Yuc.geojson', ['yucatan', 'yuc']],
    ['32', 'Zacatecas', '32-Zac.geojson', ['zacatecas', 'zac']],
  ].map(([code, name, file, aliases]) => ({ code, name, file, aliases }));
  const META_BY_CODE = new Map(STATE_META.map((x) => [x.code, x]));
  const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const money = (v) => '$' + nf.format(Math.round(Number(v || 0)));
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const normalize = (s) =>
    String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();

  let DATA = null;
  let RANGE = '90d';
  let METRIC = 'sales';
  let SKU = 'all';
  let SELECTED_STATE = null;
  let STATES_GEO = null;
  const POSTAL_CACHE = new Map();
  let loading = false;

  function stateMeta(raw) {
    const n = normalize(raw);
    if (!n) return null;
    return STATE_META.find((m) => m.aliases.some((a) => n === normalize(a))) || null;
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
    else {
      const days = RANGE === '30d' ? 30 : 90;
      start = d3.utcDay.offset(maxDate, -(days - 1));
    }
    return rows.filter((r) => r._date >= start && r._date <= maxDate);
  }

  function aggregate(keyFn) {
    const grouped = d3.rollups(
      rangedRows(),
      (rows) => {
        const sales = d3.sum(rows, (r) => Number(r.sales || 0));
        const orders = d3.sum(rows, (r) => Number(r.orders || 0));
        const units = d3.sum(rows, (r) => Number(r.units || 0));
        return { sales, orders, units, aov: orders ? sales / orders : 0, rows };
      },
      keyFn,
    );
    return grouped.map(([key, value]) => ({ key, ...value }));
  }

  function stateRows() {
    return aggregate((r) => {
      const meta = stateMeta(r.state_or_region);
      return meta ? meta.code : `raw:${String(r.state_or_region || 'Unknown')}`;
    }).map((r) => {
      const meta = META_BY_CODE.get(r.key);
      const raw = r.rows.find((x) => x.state_or_region)?.state_or_region;
      return { ...r, code: meta?.code || null, label: meta?.name || raw || 'Unknown' };
    });
  }

  function postalRows(code) {
    return aggregate((r) => String(r.postal_code || '').padStart(5, '0'))
      .filter((r) => {
        if (!code) return true;
        return r.rows.some((x) => stateMeta(x.state_or_region)?.code === code);
      })
      .map((r) => ({ ...r, postal_code: r.key }));
  }

  function metricValue(r) {
    return Number(r?.[METRIC] || 0);
  }

  function metricLabel() {
    return { sales: 'Shopper spend', orders: 'Orders', units: 'Units', aov: 'AOV' }[METRIC] || 'Value';
  }

  function formatMetric(v) {
    return METRIC === 'sales' || METRIC === 'aov' ? money(v) : nf.format(Math.round(Number(v || 0)));
  }

  function scaleFor(rows) {
    const max = d3.max(rows, metricValue) || 0;
    if (!max) return () => '#f0ece5';
    return d3.scaleLinear().domain([0, max]).range(['#f2eadc', '#b66f1e']).clamp(true);
  }

  function setText(id, value) {
    const e = document.getElementById(id);
    if (e) e.textContent = value;
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
    const p = (DATA?.geography?.products || []).find((x) => String(x.sku) === SKU);
    return p?.product || SKU;
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
      .map(([l, v, n]) => `<div class="geo-kpi"><span>${esc(l)}</span><strong>${esc(v)}</strong><small>${esc(n)}</small></div>`)
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

  function showTip(event, title, row) {
    const tip = tooltip();
    const host = document.querySelector('.geo-map-panel');
    if (!tip || !host) return;
    tip.innerHTML = `<strong>${esc(title)}</strong><span>${metricLabel()} · ${esc(formatMetric(metricValue(row)))}</span><span>${money(row?.sales || 0)} · ${nf.format(row?.orders || 0)} orders · ${nf.format(row?.units || 0)} units</span>`;
    const rect = host.getBoundingClientRect();
    tip.style.left = `${Math.max(10, Math.min(rect.width - 230, event.clientX - rect.left + 12))}px`;
    tip.style.top = `${Math.max(10, Math.min(rect.height - 86, event.clientY - rect.top + 12))}px`;
    tip.classList.add('show');
  }

  function hideTip() {
    tooltip()?.classList.remove('show');
  }

  async function getStatesGeo() {
    if (STATES_GEO) return STATES_GEO;
    const r = await fetch(STATES_URL, { cache: 'force-cache' });
    if (!r.ok) throw new Error(`State map HTTP ${r.status}`);
    STATES_GEO = await r.json();
    return STATES_GEO;
  }

  async function getPostalGeo(code) {
    if (POSTAL_CACHE.has(code)) return POSTAL_CACHE.get(code);
    const meta = META_BY_CODE.get(code);
    if (!meta) throw new Error('Unknown state');
    const r = await fetch(POSTAL_BASE + meta.file, { cache: 'force-cache' });
    if (!r.ok) throw new Error(`Postal map HTTP ${r.status}`);
    const geo = await r.json();
    POSTAL_CACHE.set(code, geo);
    return geo;
  }

  function mapShell() {
    const svg = d3.select('#geoMap');
    svg.selectAll('*').remove();
    const node = svg.node();
    const host = node?.parentElement;
    const width = Math.max(520, host?.clientWidth || 900);
    const height = width < 720 ? 430 : 520;
    svg.attr('viewBox', `0 0 ${width} ${height}`).attr('role', 'img');
    return { svg, width, height };
  }

  async function renderNationalMap() {
    const shell = mapShell();
    setText('geoMapStatus', 'Mexico · click a state to inspect postal codes');
    try {
      const geo = await getStatesGeo();
      const rows = stateRows();
      const byCode = new Map(rows.filter((r) => r.code).map((r) => [r.code, r]));
      const fill = scaleFor(rows);
      const projection = d3.geoMercator().fitExtent([[22, 18], [shell.width - 22, shell.height - 20]], geo);
      const path = d3.geoPath(projection);
      shell.svg
        .append('g')
        .selectAll('path')
        .data(geo.features || [])
        .join('path')
        .attr('class', 'geo-shape state-shape')
        .attr('d', path)
        .attr('fill', (f) => {
          const code = String(Number(f.properties?.state_code || 0)).padStart(2, '0');
          return fill(metricValue(byCode.get(code)));
        })
        .attr('tabindex', 0)
        .on('pointerenter pointermove focus', function (event, f) {
          const code = String(Number(f.properties?.state_code || 0)).padStart(2, '0');
          const row = byCode.get(code) || { sales: 0, orders: 0, units: 0, aov: 0 };
          const title = META_BY_CODE.get(code)?.name || f.properties?.state_name || code;
          showTip(event, title, row);
        })
        .on('pointerleave blur', hideTip)
        .on('click keydown', function (event, f) {
          if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
          const code = String(Number(f.properties?.state_code || 0)).padStart(2, '0');
          selectState(code);
        });
    } catch (err) {
      console.error(err);
      setText('geoMapStatus', 'Map geometry unavailable · ranked geography remains available');
      shell.svg
        .append('text')
        .attr('x', shell.width / 2)
        .attr('y', shell.height / 2)
        .attr('text-anchor', 'middle')
        .attr('class', 'geo-map-fallback')
        .text('Map geometry unavailable');
    }
  }

  async function renderPostalMap(code) {
    const shell = mapShell();
    const meta = META_BY_CODE.get(code);
    setText('geoMapStatus', `${meta?.name || 'State'} · postal-code demand`);
    try {
      const geo = await getPostalGeo(code);
      const rows = postalRows(code);
      const byPostal = new Map(rows.map((r) => [String(r.postal_code).padStart(5, '0'), r]));
      const fill = scaleFor(rows);
      const projection = d3.geoMercator().fitExtent([[20, 18], [shell.width - 20, shell.height - 18]], geo);
      const path = d3.geoPath(projection);
      shell.svg
        .append('g')
        .selectAll('path')
        .data(geo.features || [])
        .join('path')
        .attr('class', 'geo-shape postal-shape')
        .attr('d', path)
        .attr('fill', (f) => {
          const cp = String(f.properties?.d_codigo || '').padStart(5, '0');
          const row = byPostal.get(cp);
          return row ? fill(metricValue(row)) : '#f2efe9';
        })
        .attr('tabindex', 0)
        .on('pointerenter pointermove focus', function (event, f) {
          const cp = String(f.properties?.d_codigo || '').padStart(5, '0');
          const row = byPostal.get(cp) || { sales: 0, orders: 0, units: 0, aov: 0 };
          showTip(event, `CP ${cp}`, row);
        })
        .on('pointerleave blur', hideTip);
    } catch (err) {
      console.error(err);
      setText('geoMapStatus', `${meta?.name || 'State'} · postal geometry unavailable`);
      shell.svg
        .append('text')
        .attr('x', shell.width / 2)
        .attr('y', shell.height / 2)
        .attr('text-anchor', 'middle')
        .attr('class', 'geo-map-fallback')
        .text('Postal geometry unavailable');
    }
  }

  function renderRanked() {
    const out = document.getElementById('geoRankedRows');
    const title = document.getElementById('geoRankedTitle');
    if (!out || !title) return;
    let rows;
    if (SELECTED_STATE) {
      rows = postalRows(SELECTED_STATE).sort((a, b) => d3.descending(metricValue(a), metricValue(b)));
      title.textContent = `Top postal codes · ${META_BY_CODE.get(SELECTED_STATE)?.name || ''}`;
    } else {
      rows = stateRows().sort((a, b) => d3.descending(metricValue(a), metricValue(b)));
      title.textContent = 'Top states';
    }
    out.innerHTML = rows
      .slice(0, 20)
      .map((r) => {
        const label = SELECTED_STATE ? `CP ${r.postal_code}` : r.label;
        const click = !SELECTED_STATE && r.code ? ` data-state="${r.code}" tabindex="0" role="button"` : '';
        return `<tr${click}><td><strong>${esc(label)}</strong></td><td class="num"><strong>${esc(formatMetric(metricValue(r)))}</strong></td><td class="num">${money(r.sales)}</td><td class="num">${nf.format(r.orders)}</td><td class="num">${nf.format(r.units)}</td><td class="num">${money(r.aov)}</td></tr>`;
      })
      .join('');
    out.querySelectorAll('[data-state]').forEach((row) => {
      const go = () => selectState(row.dataset.state);
      row.addEventListener('click', go);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') go();
      });
    });
  }

  async function renderMap() {
    if (loading) return;
    loading = true;
    try {
      await (SELECTED_STATE ? renderPostalMap(SELECTED_STATE) : renderNationalMap());
    } finally {
      loading = false;
    }
  }

  function renderAll() {
    if (!DATA) return;
    setText('geoCoverage', coverageCopy());
    const back = document.getElementById('geoBack');
    if (back) back.hidden = !SELECTED_STATE;
    const stateSelect = document.getElementById('geoStateSelect');
    if (stateSelect) stateSelect.value = SELECTED_STATE || 'all';
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
    document.getElementById('geoRange')?.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-geo-range]');
      if (!b) return;
      RANGE = b.dataset.geoRange;
      document.querySelectorAll('[data-geo-range]').forEach((x) => x.classList.toggle('active', x === b));
      renderAll();
    });
    document.getElementById('geoMetric')?.addEventListener('change', (e) => {
      METRIC = e.target.value;
      renderAll();
    });
    document.getElementById('geoProduct')?.addEventListener('change', (e) => {
      SKU = e.target.value;
      renderAll();
    });
    document.getElementById('geoStateSelect')?.addEventListener('change', (e) => selectState(e.target.value));
    document.getElementById('geoBack')?.addEventListener('click', () => selectState(null));
    document.querySelector('[data-view="geography"]')?.addEventListener('click', () => {
      if (DATA) renderAll();
      else load();
    });
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

  async function load() {
    try {
      const r = await fetch('/api/sales', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      DATA = await r.json();
      initControls();
      renderAll();
    } catch (err) {
      console.error(err);
      setText('geoCoverage', 'Geography data unavailable');
      setText('geoMapStatus', 'Geography data unavailable');
    }
  }

  bind();
})();
