(() => {
  const money = value => '$' + new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.round(Number(value || 0)));
  const rate = value => value == null ? '—' : (Number(value) * 100).toFixed(1) + '%';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  const style = document.createElement('style');
  style.textContent = `
    .home-paid{display:flex;gap:15px;align-items:center;margin:0 2px 17px;padding:0 2px 14px;border-bottom:1px solid var(--line);font-size:12px;color:var(--muted)}
    .home-paid strong{color:var(--ink);font-size:13px}.home-paid .paid-pill{display:inline-flex;gap:6px;align-items:center;white-space:nowrap}.home-paid .paid-dot{width:8px;height:8px;border-radius:50%;background:var(--faint)}
    .home-paid.good .paid-dot{background:var(--good)}.home-paid.bad .paid-dot{background:var(--bad)}.home-paid.warn .paid-dot{background:var(--warn)}.home-paid a{margin-left:auto;color:var(--accent-ink);text-decoration:none;font-weight:800;white-space:nowrap}
    @media(max-width:640px){.home-paid{display:grid;grid-template-columns:1fr auto;gap:5px 10px;line-height:1.4}.home-paid .paid-context-copy{grid-column:1/-1}.home-paid a{grid-column:2;grid-row:1;margin:0}.home-paid .paid-pill{grid-column:1;grid-row:1}}
  `;
  document.head.appendChild(style);

  function read(s) {
    const t = s.tacos_delta_points == null ? null : Number(s.tacos_delta_points);
    const spend = s.spend_delta_pct == null ? null : Number(s.spend_delta_pct);
    if (t != null && t <= -1) return { tone: 'good', text: `Paid support is taking ${Math.abs(t).toFixed(1)} points less of total sales than the prior 28 days.` };
    if (t != null && t >= 1) return { tone: 'bad', text: `Paid support is taking ${t.toFixed(1)} points more of total sales than the prior 28 days.` };
    if (spend != null && Math.abs(spend) >= 10) return { tone: 'warn', text: `Ad spend moved ${spend > 0 ? '+' : ''}${spend.toFixed(1)}% while total-sales efficiency stayed broadly stable.` };
    return { tone: '', text: 'Paid-support efficiency is broadly stable versus the prior 28 days.' };
  }

  fetch('/api/ads', { cache: 'no-store' })
    .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
    .then(data => {
      if (data.status !== 'ready') return;
      const s = data.summary || {};
      const r = read(s);
      const story = document.getElementById('story');
      if (!story || document.getElementById('homePaid')) return;
      const node = document.createElement('div');
      node.id = 'homePaid';
      node.className = `home-paid ${r.tone}`;
      node.innerHTML = `<span class="paid-pill"><span class="paid-dot"></span><strong>Ads · ${rate(s.tacos)} TACOS</strong></span><span class="paid-context-copy">${esc(r.text)} ${money(s.spend)} spend · ${rate(s.acos)} ACOS · through ${esc(String(data.freshness?.through_date || '').slice(5))}</span><a href="/ads">Open Ads →</a>`;
      story.insertAdjacentElement('afterend', node);

      const copy = document.getElementById('storyCopy');
      if (copy && r.text) copy.textContent = `${copy.textContent.trim()} ${r.text}`;
    })
    .catch(() => {});
})();
