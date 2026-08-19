(function(){
  document.body.classList.add('board-refined');
  var params=new URLSearchParams(location.search);
  if(params.get('wall')==='1') document.body.classList.add('wall');

  var productStyle=document.createElement('style');
  productStyle.textContent='.product-cell{display:flex;align-items:center;gap:9px;min-width:0}.product-copy{min-width:0;flex:1}.product-thumb{width:34px;height:42px;object-fit:contain;border-radius:5px;background:#f4f0e8;flex:0 0 auto}.product-link{color:inherit;text-decoration:none}.product-link:hover .product,.product-link:hover .action-product{color:var(--accent2);text-decoration:underline;text-decoration-color:rgba(255,210,119,.35);text-underline-offset:3px}@media(max-width:1100px){.product-thumb{width:27px;height:34px}.product-cell{gap:6px}}';
  document.head.appendChild(productStyle);

  var productMeta={};

  function relocateAttention(){
    var attention=document.querySelector('.attention');
    var main=document.querySelector('.main');
    var bottom=document.querySelector('.bottom');
    if(attention && main && attention.parentNode===bottom){
      main.parentNode.insertBefore(attention,main);
      bottom.classList.add('context-only');
    }
    var title=document.querySelector('.context .section-title h2');
    var note=document.querySelector('.context .section-title span');
    if(title) title.textContent='Business pulse';
    if(note) note.textContent='Rules-based';

    [['/d/dpp-sales','/sales'],['/d/dpp-inventory','/inventory']].forEach(function(pair){
      var a=document.querySelector('.nav a[data-grafana="'+pair[0]+'"]');
      if(a){a.removeAttribute('data-grafana');a.href=pair[1]}
    });

    document.querySelectorAll('.nav a:not([href]):not([data-grafana])').forEach(function(a){
      a.classList.add('disabled');
      a.setAttribute('aria-disabled','true');
      a.title='Not connected yet';
    });
  }

  function refineSignals(){
    var ordersEl=document.getElementById('todayOrders');
    var paceEl=document.getElementById('todayPace');
    var paceWrap=paceEl && paceEl.closest('.pace');
    if(ordersEl && paceEl && paceWrap){
      var orders=parseInt(String(ordersEl.textContent||'0').replace(/[^0-9-]/g,''),10)||0;
      paceWrap.classList.toggle('low-signal',orders<3);
      if(orders<3){
        paceEl.classList.remove('good','bad');
        paceEl.title='Directional only: fewer than 3 orders today';
      }else{
        paceEl.title='Compared with the prior matching weekdays at the same local time';
      }
    }
  }

  function linkProduct(el,meta){
    if(!el || !meta) return;
    if(meta.catalog_title) el.title=meta.catalog_title;
    if(!meta.amazon_url) return;
    var parent=el.parentElement;
    if(parent && parent.classList.contains('product-link')){
      parent.href=meta.amazon_url;
      return;
    }
    var a=document.createElement('a');
    a.className='product-link';
    a.href=meta.amazon_url;
    a.target='_blank';
    a.rel='noopener noreferrer';
    el.parentNode.insertBefore(a,el);
    a.appendChild(el);
  }

  function decorateMover(row){
    var skuEl=row.querySelector('.sku');
    if(!skuEl) return;
    var meta=productMeta[skuEl.textContent.trim()];
    if(!meta) return;
    var product=row.querySelector('.product');
    linkProduct(product,meta);

    var cell=row.firstElementChild;
    if(!cell) return;
    cell.classList.add('product-cell');
    if(!cell.querySelector('.product-copy')){
      var copy=document.createElement('div');
      copy.className='product-copy';
      Array.from(cell.childNodes).forEach(function(node){copy.appendChild(node)});
      cell.appendChild(copy);
    }
    if(meta.image_url && !cell.querySelector('.product-thumb')){
      var img=document.createElement('img');
      img.className='product-thumb';
      img.src=meta.image_url;
      img.alt='';
      img.loading='lazy';
      img.referrerPolicy='no-referrer';
      cell.insertBefore(img,cell.firstChild);
    }
  }

  function decorateAttention(row){
    var skuEl=row.querySelector('.sku');
    if(!skuEl) return;
    var meta=productMeta[skuEl.textContent.trim()];
    if(!meta) return;
    linkProduct(row.querySelector('.action-product'),meta);
  }

  function applyProductMeta(){
    document.querySelectorAll('.mover').forEach(decorateMover);
    document.querySelectorAll('.action-item').forEach(decorateAttention);
  }

  function refreshProductMeta(){
    fetch('/api/home',{cache:'no-store'})
      .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()})
      .then(function(d){
        productMeta={};
        (d.movers||[]).concat(d.inventory||[]).forEach(function(item){
          if(item && item.sku) productMeta[item.sku]=item;
        });
        applyProductMeta();
      })
      .catch(function(){});
  }

  function refineDynamic(){
    var attention=document.querySelector('.attention');
    var list=document.getElementById('attention');
    if(attention && list){
      var count=list.querySelectorAll('.action-item').length;
      attention.classList.toggle('single',count===1);
      attention.classList.toggle('clear',count===0);
    }
    refineSignals();
    applyProductMeta();
  }

  relocateAttention();
  refineDynamic();
  refreshProductMeta();
  setInterval(refreshProductMeta,60000);

  var app=document.querySelector('.app');
  if(app){
    var pending=false;
    new MutationObserver(function(){
      if(pending) return;
      pending=true;
      requestAnimationFrame(function(){
        pending=false;
        refineDynamic();
      });
    }).observe(app,{childList:true,subtree:true,characterData:true});
  }
})();
