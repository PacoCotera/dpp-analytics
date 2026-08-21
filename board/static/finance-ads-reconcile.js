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

    // OPEN month only: use Ads spend by advertising date as a provisional accrual.
    // Finance close remains accounting-period based. ProductAdsPayment belongs to
    // the following-month bridge for the prior month and must never be compared
    // against an arbitrary rolling 28-day Ads window.
    if (monthRows.length) {
      const pending = document.querySelector('#statementView .open-line.pending');
      if (pending) {
        const name = pending.querySelector('.name');
        const note = pending.querySelector('.note');
        const value = pending.querySelector('.value');
        pending.classList.remove('pending');
        if (name) name.textContent = 'Advertising accrued this month';
        if (note) note.innerHTML = `Campaign spend by advertising date through ${esc(adsThrough)}. OPEN and provisional; attribution can continue to revise.`;
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
        if (note) note.innerHTML = `Includes ${money(currentSpend)} of Ads spend accrued through ${esc(adsThrough)}. Still provisional until Amazon order releases, advertising close and close grace complete.`;
        if (value) {
          value.textContent = money(afterAds);
          value.classList.remove('neg','pos');
          if (afterAds < 0) value.classList.add('neg');
          else if (afterAds > 0) value.classList.add('pos');
        }
      }
    }

    const host = document.querySelector('.accounting-note');
    if (!host || document.getElementById('adsReconcile')) return;
    const node = document.createElement('div');
    node.id = 'adsReconcile';
    node.className = 'ads-reconcile';
    node.innerHTML = `<div class="ads-reconcile-head"><strong>Advertising follows the accounting month here.</strong><a href="/ads">Open Ads →</a></div><div>For the OPEN month, campaign spend is a provisional accrual by advertising date. Historical close uses the monthly reconciliation contract: mature Ads API accrual when available, otherwise the following calendar month's RELEASED ProductAdsPayment bridge. Rolling 28-day Ads and finance postings are intentionally not reconciled because their clocks do not align.</div>${monthRows.length ? `<div class="ads-reconcile-values"><span>${esc(currentMonth)} accrued Ads · <b>${money(currentSpend)}</b></span><span>Attributed sales · <b>${money(currentAttributed)}</b></span><span>TACOS · <b>${pct(ads.summary?.tacos)}</b></span><span>Ads through · <b>${esc(adsThrough)}</b></span></div><div class="ads-live-note">Attributed sales are Amazon attribution, not incremental sales. Total sales minus attributed sales is not exact organic sales.</div>` : `<div class="ads-live-note">No Ads rows are available for the OPEN month yet. Finance will keep advertising provisional rather than substitute a rolling-window estimate.</div>`}`;
    host.appendChild(node);
  }

  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if (document.querySelector('#statementView .open-lines') || tries > 12) {
      clearInterval(timer);
      load().catch(() => {});
    }
  }, 250);
})();
