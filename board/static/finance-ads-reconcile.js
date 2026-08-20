(() => {
  const money = value => {
    const n = Number(value || 0);
    return (n < 0 ? '−$' : '$') + new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.abs(Math.round(n)));
  };
  const pct = value => value == null ? '—' : (Number(value) * 100).toFixed(1) + '%';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  const style = document.createElement('style');
  style.textContent = `
    .ads-reconcile{margin-top:12px;padding-top:12px;border-top:1px solid var(--line);font-size:12px;color:var(--muted);line-height:1.45}
    .ads-reconcile-head{display:flex;justify-content:space-between;gap:12px;align-items:baseline}.ads-reconcile-head strong{color:var(--ink);font-size:13px}.ads-reconcile a{color:var(--accent-ink);font-weight:800;text-decoration:none;white-space:nowrap}
    .ads-reconcile-values{display:flex;gap:16px;flex-wrap:wrap;margin-top:6px}.ads-reconcile-values b{color:var(--ink)}
    @media(max-width:640px){.ads-reconcile-head{align-items:flex-start}.ads-reconcile-values{display:grid;grid-template-columns:1fr 1fr;gap:5px 10px}}
  `;
  document.head.appendChild(style);

  Promise.all([
    fetch('/api/finance', {cache:'no-store'}).then(r => r.ok ? r.json() : Promise.reject(new Error(`finance ${r.status}`))),
    fetch('/api/ads', {cache:'no-store'}).then(r => r.ok ? r.json() : Promise.reject(new Error(`ads ${r.status}`)))
  ]).then(([finance, ads]) => {
    if (ads.status !== 'ready') return;
    const host = document.querySelector('.accounting-note');
    if (!host || document.getElementById('adsReconcile')) return;
    const ledger = Math.abs(Number(finance.summary?.ads_amount_28 || 0));
    const reported = Number(ads.summary?.spend || 0);
    const difference = reported - ledger;
    const material = Math.abs(difference) > Math.max(100, reported * .08);
    const node = document.createElement('div');
    node.id = 'adsReconcile';
    node.className = 'ads-reconcile';
    node.innerHTML = `<div class="ads-reconcile-head"><strong>Advertising has two accounting clocks.</strong><a href="/ads">Open Ads →</a></div><div>Ads reporting measures campaign spend by advertising date; ProductAdsPayment is Amazon's finance-posted charge. They should converge over time, not match day by day.</div><div class="ads-reconcile-values"><span>Ads report · <b>${money(reported)}</b></span><span>Finance ledger · <b>${money(ledger)}</b></span><span>Difference · <b>${money(difference)}</b>${material ? ' · timing/reconciliation worth watching' : ''}</span><span>TACOS · <b>${pct(ads.summary?.tacos)}</b></span></div><div>Ads through ${esc(String(ads.freshness?.through_date || '').slice(0,10))}; finance through ${esc(String(finance.summary?.latest_posted || '').slice(0,10))}.</div>`;
    host.appendChild(node);
  }).catch(() => {});
})();
