(() => {
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const monthName=s=>{if(!s)return'—';const [y,m]=String(s).slice(0,7).split('-').map(Number);return `${months[m-1]} ${String(y).slice(-2)}`};

  async function clarify(){
    try{
      const r=await fetch('/api/finance',{cache:'no-store'}); if(!r.ok)return;
      const d=await r.json();
      const fin=d.finalizing_months||[];
      const host=document.querySelector('.finalizing');
      if(host&&fin.length){
        host.innerHTML=`<h3>Historical months not yet management-closed</h3>${fin.slice().reverse().map(m=>{
          const missing=m.missing_skus||[];
          let why='';
          if(m.amazon_state==='CLOSED'&&missing.length){
            why=`Amazon closed · missing ${missing.map(x=>`${esc(x.sku)} (${Number(x.units||0)}u)`).join(', ')}`;
          }else{
            why=`Waiting for ${esc((m.close_waits_for||[]).join(', ')||'final Amazon releases')}`;
          }
          return `<div class="finalizing-row"><strong>${monthName(m.month)}</strong><span>${why}</span></div>`;
        }).join('')}`;
      }
      document.querySelectorAll('.close-row:not(.header)').forEach(row=>{
        const cost=row.querySelector('[data-label="Product cost"] span');
        if(cost&&/covered/.test(cost.textContent||'')) cost.textContent='frozen at close';
      });
    }catch(_){ }
  }
  setTimeout(clarify,1400);
  setTimeout(clarify,3000);
})();
