/* Today clarity pass: compact recent-day selector + explicit order transactions. */
(() => {
  if (!document.body.classList.contains('today-shell')) return;

  const style = document.createElement('style');
  style.textContent = `
    .day-picker{
      display:grid!important;
      grid-template-columns:repeat(8,minmax(0,1fr));
      gap:6px!important;
      overflow:visible!important;
      width:100%;
    }
    .day-choice{
      min-width:0!important;
      width:100%;
      min-height:54px!important;
      padding:7px 9px!important;
      overflow:hidden;
    }
    .day-choice b{font-size:12px!important;overflow:hidden;text-overflow:ellipsis}
    .day-choice span{font-size:9.5px!important}
    .day-choice.partial:after{font-size:7.5px!important;margin-left:4px!important}
    .order-stream.order-ledger{
      display:grid!important;
      grid-template-columns:repeat(3,minmax(0,1fr));
      gap:8px!important;
      overflow:visible!important;
    }
    .order-transaction{
      min-width:0;
      border:1px solid #e4dcd0;
      background:#f8f4ed;
      border-radius:16px;
      padding:13px 14px;
    }
    .order-transaction .ot-top{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
    .order-transaction .ot-amount{font-size:22px;font-weight:850;letter-spacing:-.035em}
    .order-transaction .ot-time{font-size:12px;color:var(--muted);font-weight:700;padding-top:3px;white-space:nowrap}
    .order-transaction .ot-name{font-size:13px;font-weight:760;line-height:1.3;margin-top:7px;white-space:normal;overflow:visible}
    .order-transaction .ot-meta{display:flex;gap:7px;flex-wrap:wrap;margin-top:8px;color:var(--muted);font-size:11px;line-height:1.35}
    .order-transaction .ot-meta b{color:var(--ink);font-weight:760}
    .wall-mode .order-transaction{background:#1d1915;border-color:#3a3127}
    .wall-mode .order-transaction .ot-meta,.wall-mode .order-transaction .ot-time{color:#c5baaa}
    .wall-mode .order-transaction .ot-meta b{color:#fff8ed}
    @media(max-width:980px){
      .day-picker{grid-template-columns:repeat(4,minmax(0,1fr))!important}
      .order-stream.order-ledger{grid-template-columns:repeat(2,minmax(0,1fr))!important}
    }
    @media(max-width:640px){
      .day-picker{grid-template-columns:repeat(4,minmax(0,1fr))!important;margin-top:-7px!important;margin-bottom:14px!important}
      .day-choice{min-height:50px!important;padding:6px 7px!important;border-radius:13px!important}
      .day-choice b{font-size:11.5px!important}
      .day-choice span{font-size:9px!important}
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
    const wins = document.querySelector('.wins .panel-title');
    if (wins) wins.textContent = 'Orders';
    const winsSub = document.getElementById('winsSub');
    if (winsSub) {
      const current = winsSub.textContent.replace(/\s*·\s*newest first/i, '').trim();
      winsSub.textContent = `${current || 'Selected day'} · sale transactions · newest first`;
    }
  }

  function selectedDate() {
    const active = document.querySelector('#dayPicker .day-choice.active');
    return active?.dataset?.date || new URLSearchParams(location.search).get('date') || '';
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
      const orders = d.recent_orders || [];
      const key = `${d.selected_date || ''}:${orders.map(o => o.order_id).join(',')}`;
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
      // The base Today page already owns the visible error state.
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
