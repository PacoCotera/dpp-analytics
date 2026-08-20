(() => {
  const money = value => {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
    const n = Number(value);
    return (n < 0 ? '−$' : '$') + new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.abs(Math.round(n)));
  };
  const pct = value => value == null ? '—' : (Number(value) * 100).toFixed(1) + '%';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const monthKey = value => String(value || '').slice(0, 7);

  const style = document.createElement('style');
  style.textContent = `
    .ads-reconcile{margin-top:12px;padding-top:12px;border-top:1px solid var(--line);font-size:12px;color:var(--muted);line-height:1.45}
    .ads-reconcile-head{display:flex;justify-content:space-between;gap:12px;align-items:baseline}.ads-reconcile-head strong{color:var(--ink);font-size:13px}.ads-reconcile a{color:var(--accent-ink);font-weight:800;text-decoration:none;white-space:nowrap}
    .ads-reconcile-values{display:flex;gap:16px;flex-wrap:wrap;margin-top:6px}.ads-reconcile-values b{color:var(--ink)}
    .ads-live-note{font-size:11px;color:var(--muted);line-height:1.4;margin-top:2px}
    @media(max-width:640px){.ads-reconcile-head{align-items:flex-start}.ads-reconcile-values{display:grid;grid-template-columns:1fr 1fr;gap:5px 10px}}
  `;
  document.head.appendChild(style);

  async function load() {
    const [finance, ads] = await Promise.all([
      fetch('/api/finance', {cache:'no-store'}).then(r => r.ok ? r.json() : Promise.reject(new Error(`finance ${r.status}`))),
      fetch('/api/ads', {cache:'no-store'}).then(r => r.ok ? r.json() : Promise.reject(new Error(`ads ${r.status}`)))
    ]);
    if (ads.status !== 'ready') return;

    const current = finance.current_month || {};
    const currentMonth = monthKey(current.month);
    const daily = Array.isArray(ads.daily) ? ads.daily : [];
    const monthRows = daily.filter(row => monthKey(row.business_date) === currentMonth);
    const currentSpend = monthRows.reduce((sum, row) => sum + Number(row.spend || 0), 0);
    const currentAttributed = monthRows.reduce((sum, row) => sum + Number(row.attributed_sales || 0), 0);
    const currentClicks = monthRows.reduce((sum, row) => sum + Number(row.clicks || 0), 0);
    const currentImpressions = monthRows.reduce((sum, row) => sum + Number(row.impressions || 0), 0);
    const adsThrough = String(ads.freshness?.through_date || '').slice(0,10);

    // Replace the deliberately pending placeholder only when the Ads warehouse
    // actually contains rows for the OPEN business month. This is an accrual by
    // advertising date, not Amazon's later ProductAdsPayment posting.
    if (monthRows.length) {
      const pending = document.querySelector('#statementView .open-line.pending');
      if (pending) {
        const name = pending.querySelector('.name');
        const note = pending.querySelector('.note');
        const value = pending.querySelector('.value');
        pending.classList.remove('pending');
        if (name) name.textContent = 'Advertising accrued this month';
        if (note) note.innerHTML = `Campaign spend by advertising date through ${esc(adsThrough)}. Attribution can continue to revise after that date.`;
        if (value) {
          value.textContent = money(-Math.abs(currentSpend));
          value.classList.add('neg');
        }
      }

      const total = document.querySelector('#statementView .open-line.total');
      const beforeAds = Number(current.estimated_contribution_before_current_ads);
      if (total && Number.isFinite(beforeAds)) {
        const name = total.querySelector('.name');
        const note = total.querySelector('.note');
        const value = total.querySelector('.value');
        const afterAds = beforeAds - currentSpend;
        if (name) name.textContent = 'Estimated contribution so far';
        if (note) note.innerHTML = `Includes ${money(currentSpend)} of Ads spend accrued through ${esc(adsThrough)}. Still provisional until Amazon order releases and month close.`;
        if (value) {
          value.textContent = money(afterAds);
          value.classList.remove('neg','pos');
          value.classList.add(afterAds < 0 ? 'neg' : afterAds > 0 ? 'pos' : '');
        }
      }
    }

    const host = document.querySelector('.accounting-note');
    if (!host || document.getElementById('adsReconcile')) return;
    const ledger = Math.abs(Number(finance.summary?.ads_amount_28 || 0));
    const reported = Number(ads.summary?.spend || 0);
    const difference = reported - ledger;
    const material = Math.abs(difference) > Math.max(100, reported * .08);
    const node = document.createElement('div');
    node.id = 'adsReconcile';
    node.className = 'ads-reconcile';
    node.innerHTML = `<div class="ads-reconcile-head"><strong>Advertising has two accounting clocks.</strong><a href="/ads">Open Ads →</a></div><div>Ads reporting measures campaign spend by advertising date; ProductAdsPayment is Amazon's finance-posted charge. They should converge over time, not match day by day.</div><div class="ads-reconcile-values"><span>Latest 28 Ads days · <b>${money(reported)}</b></span><span>Finance ledger · <b>${money(ledger)}</b></span><span>Difference · <b>${money(difference)}</b>${material ? ' · timing/reconciliation worth watching' : ''}</span><span>TACOS · <b>${pct(ads.summary?.tacos)}</b></span></div>${monthRows.length ? `<div class="ads-reconcile-values"><span>${esc(currentMonth)} accrued Ads · <b>${money(currentSpend)}</b></span><span>Attributed sales · <b>${money(currentAttributed)}</b></span><span>Clicks · <b>${new Intl.NumberFormat('en-US').format(currentClicks)}</b></span><span>Impressions · <b>${new Intl.NumberFormat('en-US').format(currentImpressions)}</b></span></div>` : ''}<div>Ads through ${esc(adsThrough)}; finance through ${esc(String(finance.summary?.latest_posted || '').slice(0,10))}.</div>`;
    host.appendChild(node);
  }

  // finance-manager-v2 renders asynchronously after page load. Retry briefly so
  // this enhancement never races the base Finance view.
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if (document.querySelector('#statementView .open-lines') || tries > 12) {
      clearInterval(timer);
      load().catch(() => {});
    }
  }, 250);
})();
