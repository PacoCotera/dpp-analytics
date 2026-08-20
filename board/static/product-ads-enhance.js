(() => {
  const sku = new URLSearchParams(location.search).get('sku') || '';
  if (!sku) return;

  const money = value => '$' + new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.round(Number(value || 0)));
  const pct = value => value == null ? '—' : (Number(value) * 100).toFixed(1) + '%';
  const delta = value => value == null ? '—' : `${Number(value) > 0 ? '+' : ''}${Number(value).toFixed(1)}%`;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  const style = document.createElement('style');
  style.textContent = `
    .paid-context{margin-top:12px;padding:13px 15px;border-top:1px solid var(--line);display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:12px;align-items:center}
    .paid-context .paid-mark{width:9px;height:9px;border-radius:50%;background:var(--faint)}
    .paid-context.good .paid-mark{background:var(--good)}.paid-context.bad .paid-mark{background:var(--bad)}.paid-context.warn .paid-mark{background:var(--warn)}
    .paid-context strong{font-size:13px}.paid-context p{margin:2px 0 0;color:var(--muted);font-size:12px;line-height:1.4}.paid-context a{font-size:11px;font-weight:800;color:var(--accent-ink);text-decoration:none;white-space:nowrap}
    @media(max-width:640px){.paid-context{grid-template-columns:auto minmax(0,1fr)}.paid-context a{grid-column:2}.paid-context p{font-size:12px}}
  `;
  document.head.appendChild(style);

  function paidRead(performance, ads) {
    if (!ads || ads.status !== 'ready') {
      return { tone: '', headline: 'Paid support is not connected yet.', copy: 'Sales and demand are still valid; advertising context will appear here once Amazon Ads access is connected.' };
    }
    const sales = performance?.delta28_pct == null ? null : Number(performance.delta28_pct);
    const spend = ads.spend_delta28_pct == null ? null : Number(ads.spend_delta28_pct);
    const tacos = ads.tacos_t28 == null ? null : Number(ads.tacos_t28);
    const parts = [];
    let headline = 'Paid support is part of this product’s demand story.';
    let tone = '';

    if (sales != null && spend != null) {
      if (sales >= 8 && spend <= 0) {
        headline = 'Growth required less paid support.';
        tone = 'good';
      } else if (sales <= -8 && spend >= 8) {
        headline = 'Sales softened despite heavier paid support.';
        tone = 'bad';
      } else if (sales >= 5 && spend >= sales + 10) {
        headline = 'Growth came with substantially heavier paid support.';
        tone = 'warn';
      } else if (sales >= 5) {
        headline = 'Sales and paid support are both contributing to growth.';
        tone = 'good';
      } else if (sales <= -5 && spend <= -5) {
        headline = 'Sales and paid support both eased.';
        tone = 'warn';
      }
      parts.push(`Sales ${delta(sales)} vs prior 28; ad spend ${delta(spend)}.`);
    }
    if (tacos != null) parts.push(`TACOS is ${(tacos * 100).toFixed(1)}%.`);
    if (ads.acos_t28 != null) parts.push(`ACOS is ${(Number(ads.acos_t28) * 100).toFixed(1)}%.`);
    parts.push('Attributed ad sales are not treated as exact organic-vs-paid sales.');
    return { tone, headline, copy: parts.join(' ') };
  }

  fetch('/api/product?sku=' + encodeURIComponent(sku), { cache: 'no-store' })
    .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
    .then(data => {
      const p = data.performance || {};
      const ads = data.ads || {};
      const cards = [...document.querySelectorAll('.section .grid.four .metric')];
      if (cards.length >= 4) {
        const salesCard = cards[0];
        const paidCard = cards[1];
        const salesNote = salesCard.querySelector('.metric-note');
        if (salesNote) {
          const change = p.delta28_pct == null ? 'No prior baseline' : `${delta(p.delta28_pct)} vs prior 28`;
          salesNote.innerHTML = `${esc(change)} · ${Number(p.units_t28 || 0).toLocaleString()} units · ${Number(p.orders_t28 || 0).toLocaleString()} orders`;
        }
        const label = paidCard.querySelector('.metric-label');
        const value = paidCard.querySelector('.metric-value');
        const note = paidCard.querySelector('.metric-note');
        if (label) label.textContent = 'Paid support · 28 days';
        if (ads.status === 'ready') {
          if (value) value.textContent = ads.tacos_t28 == null ? '—' : pct(ads.tacos_t28);
          if (note) note.textContent = `${money(ads.spend_t28)} spend · ${pct(ads.acos_t28)} ACOS · through ${String(ads.through_date || '').slice(5)}`;
        } else {
          if (value) value.textContent = 'Not connected';
          if (value) value.style.fontSize = '24px';
          if (note) note.textContent = 'Amazon Ads context pending';
        }
      }

      const read = paidRead(p, ads);
      const chartCard = document.querySelector('.chart-card');
      if (chartCard && !document.getElementById('paidContext')) {
        const node = document.createElement('div');
        node.id = 'paidContext';
        node.className = `paid-context ${read.tone}`;
        node.innerHTML = `<span class="paid-mark"></span><div><strong>${esc(read.headline)}</strong><p>${esc(read.copy)}</p></div><a href="/ads">Open Ads →</a>`;
        chartCard.appendChild(node);
      }

      if (ads.status === 'ready') {
        const sub = document.getElementById('chartSub');
        if (sub) sub.textContent += ` · Ads through ${String(ads.through_date || '').slice(5)}`;
      }
    })
    .catch(() => {});
})();
