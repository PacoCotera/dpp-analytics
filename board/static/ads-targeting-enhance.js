(() => {
  'use strict';
  // ads-targeting-search-term-workspaces-v2
  const tabs = document.querySelector('.tabs');
  const footer = document.querySelector('.footer');
  if (!tabs || !footer || document.getElementById('targets')) return;

  const style = document.createElement('style');
  style.textContent = `
    .product-thumb{background:#fff!important}
    .ads-drill-intro{padding:8px 2px 16px;max-width:840px}
    .ads-drill-intro h2{margin:4px 0 6px;font-size:clamp(25px,3vw,34px);letter-spacing:-.035em}
    .ads-drill-intro p{margin:0;color:var(--muted);font-size:13px;line-height:1.5}
    .ads-signal{display:inline-flex;align-items:center;gap:6px;font-size:10px;font-weight:820;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
    .ads-signal:before{content:'';width:6px;height:6px;border-radius:50%;background:var(--faint)}
    .ads-signal.converting:before{background:var(--good)}
    .ads-signal.spend:before{background:var(--warn)}
    .ads-query{font-weight:800;font-size:14px}.ads-context{margin-top:2px;font-size:10px;color:var(--muted);line-height:1.35}
    .ads-empty-drill{padding:22px 18px;color:var(--muted);font-size:13px;line-height:1.5}
    .ads-guide{margin-top:14px;border-top:1px solid var(--line);padding:13px 2px;color:var(--muted);font-size:12px;line-height:1.5}
    .ads-guide strong{color:var(--ink)}
    .ads-action{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:999px;padding:4px 8px;font-size:10px;font-weight:820;white-space:nowrap;background:#fff}
    .ads-action.harvest{border-color:#b9d4c2;color:var(--good);background:#f4faf6}.ads-action.inspect{border-color:#e6c99c;color:#8a5a16;background:#fff9ef}.ads-action.learn{color:var(--muted)}
    @media(max-width:640px){.ads-drill-intro p{font-size:13px}.ads-query{font-size:15px}.ads-signal{font-size:9px}.ads-action{font-size:10px}}
  `;
  document.head.appendChild(style);

  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = value => '$' + new Intl.NumberFormat('en-US', {maximumFractionDigits:0}).format(Math.round(Number(value || 0)));
  const count = value => new Intl.NumberFormat('en-US', {maximumFractionDigits:0}).format(Number(value || 0));
  const pct = value => value == null ? '—' : `${(Number(value) * 100).toFixed(1)}%`;
  const multiple = value => value == null ? '—' : `${Number(value).toFixed(2)}×`;
  const signal = row => Number(row.purchases || 0) > 0
    ? '<span class="ads-signal converting">Attributed purchase</span>'
    : Number(row.spend || 0) > 0
      ? '<span class="ads-signal spend">Spend, no attributed purchase</span>'
      : '<span class="ads-signal">No spend</span>';
  const action = (row, kind) => {
    const purchases = Number(row.purchases || 0), clicks = Number(row.clicks || 0), spend = Number(row.spend || 0), roas = Number(row.roas || 0);
    if (kind === 'search' && purchases >= 2 && roas >= 2) return '<span class="ads-action harvest" title="Repeated attributed purchases with at least 2× ROAS. Review for a dedicated target; do not auto-change bids.">Harvest candidate</span>';
    if (spend > 0 && purchases === 0 && clicks >= 8) return '<span class="ads-action inspect" title="Material click learning without an attributed purchase. Inspect relevance and economics before changing targeting.">Inspect spend</span>';
    return '<span class="ads-action learn" title="Not enough evidence for a stronger operating cue yet.">Learning</span>';
  };

  const targetButton = document.createElement('button'); targetButton.type='button'; targetButton.dataset.view='targets'; targetButton.textContent='Targets';
  const searchButton = document.createElement('button'); searchButton.type='button'; searchButton.dataset.view='searchTerms'; searchButton.textContent='Search terms';
  tabs.append(targetButton, searchButton);

  const targets = document.createElement('main'); targets.id='targets'; targets.className='view';
  targets.innerHTML = `<section class="ads-drill-intro"><div class="kicker">What we bid on</div><h2>Target efficiency</h2><p>Targets are the keywords, products, categories or automatic matches we tell Amazon to pursue. Start with the highest spend and inspect whether Amazon is attributing purchases back.</p></section><section class="section"><div class="card"><div class="table-wrap"><table class="table"><thead><tr><th>Target</th><th>Campaign</th><th>Action</th><th class="num">Spend</th><th class="num">Attributed sales</th><th class="num">ACOS</th><th class="num">ROAS</th><th class="num">Clicks</th></tr></thead><tbody id="targetRows"><tr><td>Waiting for target reporting.</td></tr></tbody></table></div></div><div class="ads-guide"><strong>Operating cues are review prompts, not automation.</strong> “Inspect spend” requires at least 8 clicks with spend and no attributed purchase. Attribution can still revise, so nothing here automatically pauses, negates or changes a bid.</div></section>`;

  const searchTerms = document.createElement('main'); searchTerms.id='searchTerms'; searchTerms.className='view';
  searchTerms.innerHTML = `<section class="ads-drill-intro"><div class="kicker">What shoppers matched</div><h2>Search-term discovery</h2><p>Search terms are the shopper queries or matched products Amazon reports after ad clicks. This is the discovery layer for harvesting useful queries and spotting paid traffic that is not converting.</p></section><section class="section"><div class="card"><div class="table-wrap"><table class="table"><thead><tr><th>Search term</th><th>Campaign</th><th>Action</th><th class="num">Spend</th><th class="num">Attributed sales</th><th class="num">ACOS</th><th class="num">ROAS</th><th class="num">Clicks</th></tr></thead><tbody id="searchTermRows"><tr><td>Waiting for search-term reporting.</td></tr></tbody></table></div></div><div class="ads-guide"><strong>Discovery, not “organic” attribution.</strong> “Harvest candidate” means at least 2 attributed purchases and 2× ROAS in the current reporting window. It is a prompt to review for dedicated targeting, never proof of incrementality. We never subtract attributed sales from seller sales to invent organic sales.</div></section>`;

  footer.parentNode.insertBefore(targets, footer); footer.parentNode.insertBefore(searchTerms, footer);
  function activate(button){document.querySelectorAll('.tabs button').forEach(x=>x.classList.toggle('active',x===button));document.querySelectorAll('.view').forEach(x=>x.classList.toggle('active',x.id===button.dataset.view));}
  [targetButton,searchButton].forEach(button=>button.addEventListener('click',()=>activate(button)));

  function targetRows(rows){const body=document.getElementById('targetRows');if(!body)return;body.innerHTML=(rows||[]).map(row=>{const name=row.target_expression||row.target_id||'Unnamed target';const meta=[row.target_type,row.match_type].filter(Boolean).join(' · ');return `<tr><td class="product-cell"><div class="ads-query">${esc(name)}</div><div class="ads-context">${esc(meta)}</div>${signal(row)}</td><td data-label="Campaign"><strong>${esc(row.campaign_name||row.campaign_id||'—')}</strong></td><td data-label="Action">${action(row,'target')}</td><td data-label="Spend" class="num">${money(row.spend)}</td><td data-label="Attributed" class="num">${money(row.attributed_sales)}</td><td data-label="ACOS" class="num eff">${pct(row.acos)}</td><td data-label="ROAS" class="num eff">${multiple(row.roas)}</td><td data-label="Clicks" class="num">${count(row.clicks)}</td></tr>`;}).join('')||'<tr><td class="ads-empty-drill">No target-grain rows yet. The workspace will populate after Amazon Ads reporting is authorized and backfilled.</td></tr>';}
  function searchRows(rows){const body=document.getElementById('searchTermRows');if(!body)return;body.innerHTML=(rows||[]).map(row=>{const meta=[row.match_type,row.target_id?`target ${row.target_id}`:''].filter(Boolean).join(' · ');return `<tr><td class="product-cell"><div class="ads-query">${esc(row.search_term||'Unspecified query')}</div><div class="ads-context">${esc(meta)}</div>${signal(row)}</td><td data-label="Campaign"><strong>${esc(row.campaign_name||row.campaign_id||'—')}</strong></td><td data-label="Action">${action(row,'search')}</td><td data-label="Spend" class="num">${money(row.spend)}</td><td data-label="Attributed" class="num">${money(row.attributed_sales)}</td><td data-label="ACOS" class="num eff">${pct(row.acos)}</td><td data-label="ROAS" class="num eff">${multiple(row.roas)}</td><td data-label="Clicks" class="num">${count(row.clicks)}</td></tr>`;}).join('')||'<tr><td class="ads-empty-drill">No shopper-query rows yet. Search-term reporting will populate after Amazon Ads authorization and backfill.</td></tr>';}

  fetch('/api/ads',{cache:'no-store'}).then(response=>response.ok?response.json():Promise.reject(new Error(`HTTP ${response.status}`))).then(data=>{targetRows(data.targets||[]);searchRows(data.search_terms||[]);}).catch(()=>{targetRows([]);searchRows([]);});
})();
