(() => {
  const money = value => '$' + new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.round(Number(value || 0)));
  const rate = value => value == null ? '—' : (Number(value) * 100).toFixed(1) + '%';
  const delta = value => value == null ? '—' : `${Number(value) > 0 ? '+' : ''}${Number(value).toFixed(1)}%`;
  const pts = value => value == null ? '—' : `${Number(value) > 0 ? '+' : ''}${Number(value).toFixed(1)} pts`;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  const style = document.createElement('style');
  style.textContent = `
    .paid-strip{display:grid;grid-template-columns:minmax(0,1fr) repeat(3,auto) auto;align-items:center;gap:18px;margin-top:12px;padding:13px 15px;border:1px solid var(--line);border-radius:16px;background:rgba(255,253,249,.66)}
    .paid-strip .eyebrow{font-size:10px;letter-spacing:.08em;text-transform:uppercase;font-weight:830;color:var(--muted)}
    .paid-strip .read{font-size:13px;font-weight:780;margin-top:2px;line-height:1.35}.paid-strip .basis{font-size:11px;color:var(--muted);margin-top:2px}
    .paid-kpi{text-align:right}.paid-kpi span{display:block;font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);font-weight:800}.paid-kpi strong{display:block;font-size:17px;margin-top:2px}.paid-strip a{font-size:11px;font-weight:820;color:var(--accent-ink);text-decoration:none;white-space:nowrap}
    @media(max-width:640px){.paid-strip{grid-template-columns:1fr 1fr;gap:11px 14px}.paid-strip .paid-read{grid-column:1/-1}.paid-kpi{text-align:left}.paid-strip a{align-self:end;text-align:right}.paid-strip .basis{font-size:11px}}
  `;
  document.head.appendChild(style);

  function diagnosis(h, ads) {
    if (!ads || ads.status !== 'ready') return 'Advertising context is not connected yet.';
    const sales = h.delta28_pct == null ? null : Number(h.delta28_pct);
    const spend = ads.spend_delta28_pct == null ? null : Number(ads.spend_delta28_pct);
    const tacos = ads.tacos_delta_points == null ? null : Number(ads.tacos_delta_points);
    if (sales != null && spend != null) {
      if (sales >= 5 && tacos != null && tacos <= -0.5) return 'Recent growth is using less ad spend per peso of total sales.';
      if (sales <= -5 && spend >= 5) return 'Recent sales softened despite more paid support.';
      if (sales >= 5 && spend >= sales + 10 && tacos != null && tacos > 0.5) return 'Growth came with materially heavier paid support.';
      if (sales >= 5 && spend <= 0) return 'Sales grew while ad spend did not, a more efficient paid-support pattern.';
      if (sales <= -5 && spend <= -5) return 'Sales and paid support both eased in the latest comparable window.';
    }
    if (tacos != null && tacos <= -1) return 'Paid support is consuming a smaller share of total sales.';
    if (tacos != null && tacos >= 1) return 'Paid support is consuming a larger share of total sales.';
    return 'Paid-support efficiency is broadly stable versus the prior 28 days.';
  }

  fetch('/api/sales', { cache: 'no-store' })
    .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
    .then(data => {
      const ads = data.ads || {};
      const h = data.headline || {};
      const anchor = document.querySelector('#overview .grid.four')?.parentElement;
      if (!anchor || document.getElementById('paidSalesContext')) return;
      const node = document.createElement('div');
      node.id = 'paidSalesContext';
      node.className = 'paid-strip';
      if (ads.status === 'ready') {
        node.innerHTML = `
          <div class="paid-read"><div class="eyebrow">Paid support · Ads through ${esc(String(ads.through_date || '').slice(5))}</div><div class="read">${esc(diagnosis(h, ads))}</div><div class="basis">Latest 28 reportable Ads days · attribution can revise after the sale date.</div></div>
          <div class="paid-kpi"><span>Spend</span><strong>${money(ads.spend_t28)}</strong></div>
          <div class="paid-kpi"><span>TACOS</span><strong>${rate(ads.tacos_t28)}</strong><div class="basis">${pts(ads.tacos_delta_points)}</div></div>
          <div class="paid-kpi"><span>ACOS</span><strong>${rate(ads.acos_t28)}</strong><div class="basis">${pts(ads.acos_delta_points)}</div></div>
          <a href="/ads">Open Ads →</a>`;

        const storyCopy = document.getElementById('storyCopy');
        if (storyCopy) {
          const paid = diagnosis(h, ads);
          const current = storyCopy.textContent.trim();
          if (paid && !current.includes(paid)) storyCopy.textContent = `${current} ${paid}`;
        }
      } else {
        node.innerHTML = `<div class="paid-read"><div class="eyebrow">Paid support</div><div class="read">Advertising context is ready to connect.</div><div class="basis">Sales remains independent; Ads will add spend, ACOS and TACOS when authorization is available.</div></div><a href="/ads">Open Ads →</a>`;
      }
      anchor.appendChild(node);
    })
    .catch(() => {});
})();
