/* Today clarity pass: compact recent-day selector + explicit order transactions. */
(() => {
  if (!document.body.classList.contains('today-shell')) return;

  const style = document.createElement('style');
  style.textContent = `
    /* Recent days are a compact date rail, not eight competing cards. */
    .day-picker{
      display:grid!important;
      grid-template-columns:repeat(8,minmax(0,1fr));
      gap:3px!important;
      overflow:visible!important;
      width:100%;
      padding:0 0 8px!important;
      margin:-5px 0 15px!important;
      border-bottom:1px solid var(--line);
    }
    .day-choice{
      min-width:0!important;
      width:100%;
      min-height:40px!important;
      padding:5px 7px!important;
      border:0!important;
      border-radius:10px!important;
      background:transparent!important;
      box-shadow:none!important;
      text-align:center!important;
      overflow:hidden;
    }
    .day-choice:hover{background:rgba(255,255,255,.52)!important}
    .day-choice b{font-size:12px!important;overflow:hidden;text-overflow:ellipsis;color:var(--ink)!important}
    .day-choice span{font-size:9.5px!important;color:var(--muted)!important;margin-top:2px!important}
    .day-choice.active{background:#eee6da!important;color:var(--ink)!important}
    .day-choice.live.active{background:var(--accent)!important;color:#2b1804!important}
    .day-choice.live.active b,.day-choice.live.active span{color:#2b1804!important}
    .day-choice.partial:after{display:none!important}

    /* The sales hero remains the most important object, but earns less empty space. */
    html:not(.wall-mode) .hero{grid-template-columns:minmax(0,1.15fr) minmax(360px,.85fr)!important}
    html:not(.wall-mode) .hero-main{min-height:228px!important;padding:21px 25px!important}
    html:not(.wall-mode) .latest{min-height:228px!important;padding:18px 20px!important}
    html:not(.wall-mode) .hero-sales{font-size:clamp(76px,8vw,112px)!important;line-height:.82!important}
    html:not(.wall-mode) .hero-bottom{grid-template-columns:auto auto auto minmax(220px,1fr)!important;gap:22px!important}
    html:not(.wall-mode) .hero-stat strong{font-size:29px!important}
    html:not(.wall-mode) .benchmark-line{font-size:22px!important}
    html:not(.wall-mode) .latest-product{margin:10px 0!important;gap:13px!important}
    html:not(.wall-mode) .latest-product img{width:76px!important;height:91px!important;background:#fff!important}
    html:not(.wall-mode) .latest-name{font-size:18px!important}
    html:not(.wall-mode) .latest-amount{font-size:38px!important}
    .hero-stat.aov-stat strong{font-variant-numeric:tabular-nums}

    .latest-context{display:flex;gap:7px;flex-wrap:wrap;margin-top:6px;font-size:11px;color:var(--muted);line-height:1.35}
    .latest-context b{color:var(--ink);font-weight:760}
    .order-stream.order-ledger{display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px!important;overflow:visible!important}
    .order-transaction{min-width:0;border:1px solid #e4dcd0;background:#f8f4ed;border-radius:16px;padding:13px 14px}
    .order-transaction .ot-top{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
    .order-transaction .ot-amount{font-size:22px;font-weight:850;letter-spacing:-.035em}
    .order-transaction .ot-time{font-size:12px;color:var(--muted);font-weight:700;padding-top:3px;white-space:nowrap}
    .order-transaction .ot-name{font-size:13px;font-weight:760;line-height:1.3;margin-top:7px;white-space:normal;overflow:visible}
    .order-transaction .ot-meta{display:flex;gap:7px;flex-wrap:wrap;margin-top:8px;color:var(--muted);font-size:11px;line-height:1.35}
    .order-transaction .ot-meta b{color:var(--ink);font-weight:760}
    .wall-mode .order-transaction{background:#1d1915;border-color:#3a3127}
    .wall-mode .order-transaction .ot-meta,.wall-mode .order-transaction .ot-time,.wall-mode .latest-context{color:#c5baaa}
    .wall-mode .order-transaction .ot-meta b,.wall-mode .latest-context b{color:#fff8ed}
    .wall-mode .latest-product img,.wall-mode .product-win img{background:#fff!important}

    @media(max-width:980px){
      .day-picker{grid-template-columns:repeat(4,minmax(0,1fr))!important;gap:2px!important}
      html:not(.wall-mode) .hero{grid-template-columns:1fr!important}
      html:not(.wall-mode) .hero-bottom{grid-template-columns:auto auto auto minmax(200px,1fr)!important}
      .order-stream.order-ledger{grid-template-columns:repeat(2,minmax(0,1fr))!important}
    }
    @media(max-width:640px){
      .day-picker{grid-template-columns:repeat(4,minmax(0,1fr))!important;margin-top:-7px!important;margin-bottom:12px!important;padding-bottom:7px!important}
      .day-choice{min-height:38px!important;padding:4px 4px!important;border-radius:9px!important}
      .day-choice b{font-size:11.5px!important}
      .day-choice span{font-size:9px!important}
      html:not(.wall-mode) .hero-main{min-height:215px!important;padding:18px!important}
      html:not(.wall-mode) .hero-sales{font-size:76px!important;margin:4px 0!important}
      html:not(.wall-mode) .hero-bottom{grid-template-columns:repeat(3,minmax(0,auto))!important;gap:13px 22px!important;align-items:end!important}
      html:not(.wall-mode) .hero-stat strong{font-size:26px!important}
      html:not(.wall-mode) .benchmark{grid-column:1/-1;text-align:left!important;margin-top:2px!important;max-width:none!important}
      html:not(.wall-mode) .benchmark-line{justify-content:flex-start!important;font-size:19px!important}
      html:not(.wall-mode) .latest{min-height:auto!important}
      .order-stream.order-ledger{grid-template-columns:1fr!important}
      .order-transaction{padding:12px 13px}
      .order-transaction .ot-name{font-size:14px}
      .order-transaction .ot-amount{font-size:24px}
    }
  `;
  document.head.appendChild(style);

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const money = v => '$' + fmt.format(Math.round(Number(v || 0)));

  function tightenDayLabels() {
    const choices = [...document.querySelectorAll('#dayPicker .day-choice')];
    choices.forEach((button, i) => {
      const label = button.querySelector('b');
      if (!label || i < 2) return;
      const raw = label.textContent.trim();
      if (raw.length > 3) label.textContent = raw.slice(0, 3);
    });
  }

  function relabelSections() {
    const latest = document.getElementById('latestLabel');
    if (latest) latest.textContent = 'Latest sale';
    const productsTitle = document.getElementById('productsTitle');
    if (productsTitle) productsTitle.textContent = document.querySelector('#dayPicker .day-choice.active')?.classList.contains('live') ? 'Products sold today' : 'Products sold that day';
    const productsSub = document.getElementById('productsSub');
    if (productsSub) productsSub.textContent = 'Sales mix by product';
    const ordersTitle = document.querySelector('.wins .panel-title');
    if (ordersTitle) ordersTitle.textContent = 'Orders';
    const ordersSub = document.getElementById('winsSub');
    if (ordersSub) {
      const current = ordersSub.textContent.replace(/\s*·\s*(sale transactions\s*·\s*)?newest first/i, '').trim();
      ordersSub.textContent = `${current || 'Selected day'} · sale transactions · newest first`;
    }
  }

  function ensureAov(day) {
    const bottom = document.querySelector('.hero-bottom');
    if (!bottom) return;
    let stat = bottom.querySelector('.aov-stat');
    if (!stat) {
      stat = document.createElement('div');
      stat.className = 'hero-stat aov-stat';
      stat.innerHTML = '<strong id="todayAov">—</strong><span>avg order</span>';
      const benchmark = bottom.querySelector('.benchmark');
      bottom.insertBefore(stat, benchmark || null);
    }
    const sales = Number(day?.sales_today || 0);
    const orders = Number(day?.orders_today || 0);
    const value = document.getElementById('todayAov');
    if (value) value.textContent = orders > 0 ? money(sales / orders) : '—';
  }

  function selectedDate() {
    const active = document.querySelector('#dayPicker .day-choice.active');
    return active?.dataset?.date || new URLSearchParams(location.search).get('date') || '';
  }

  function enrichLatest(order) {
    const root = document.getElementById('latest');
    if (!root || !order) return;
    const old = root.querySelector('.latest-context');
    if (old) old.remove();
    const units = Number(order.units || 0);
    const orderShort = order.order_short || String(order.order_id || '').slice(-9) || '—';
    const meta = document.createElement('div');
    meta.className = 'latest-context';
    meta.innerHTML = `<span><b>${esc(order.sku || '—')}</b></span><span>${units} ${units === 1 ? 'unit' : 'units'}</span><span>order ${esc(orderShort)}</span>${order.status ? `<span>${esc(order.status)}</span>` : ''}`;
    root.appendChild(meta);
  }

  let rendering = false;
  let lastKey = '';
  async function enrichOrders() {
    if (rendering) return;
    const stream = document.getElementById('stream');
    if (!stream) return;
    const date = selectedDate();
    const url = '/api/today' + (date ? `?date=${encodeURIComponent(date)}` : '');
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      ensureAov(d.today || {});
      const orders = d.recent_orders || [];
      const key = `${d.selected_date || ''}:${orders.map(o => o.order_id).join(',')}`;
      enrichLatest(d.latest_order);
      if (key === lastKey && stream.classList.contains('order-ledger')) return;
      lastKey = key;
      rendering = true;
      stream.classList.add('order-ledger');
      stream.innerHTML = orders.length ? orders.map(o => {
        const sku = o.sku || '—';
        const units = Number(o.units || 0);
        const status = o.status || '—';
        const order = o.order_short || String(o.order_id || '').slice(-9) || '—';
        return `<div class="order-transaction">
          <div class="ot-top"><div class="ot-amount">${money(o.sales)}</div><div class="ot-time">${esc(o.local_time || '')}</div></div>
          <div class="ot-name">${esc(o.product || sku || 'Order')}</div>
          <div class="ot-meta"><span><b>${esc(sku)}</b></span><span>${units} ${units === 1 ? 'unit' : 'units'}</span><span>order ${esc(order)}</span><span>${esc(status)}</span></div>
        </div>`;
      }).join('') : `<div class="empty-live">${d.is_live ? 'No orders yet today.' : 'No orders recorded for this day.'}</div>`;
    } catch (_) {
      // The base Today page owns the visible error state.
    } finally {
      rendering = false;
    }
  }

  let timer = null;
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      tightenDayLabels();
      relabelSections();
      enrichOrders();
    }, 35);
  };

  const picker = document.getElementById('dayPicker');
  const stream = document.getElementById('stream');
  if (picker) new MutationObserver(refresh).observe(picker, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  if (stream) new MutationObserver(() => { if (!rendering) refresh(); }).observe(stream, { childList: true, subtree: true });
  window.addEventListener('popstate', refresh);
  refresh();
})();