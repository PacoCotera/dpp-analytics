(function(){
  document.body.classList.add('board-refined');
  var params=new URLSearchParams(location.search);
  if(params.get('wall')==='1') document.body.classList.add('wall');

  function shortProduct(text){
    text=String(text||'').trim();
    var quoted=text.match(/"([^"]+)"/);
    if(quoted && quoted[1]){
      var q=quoted[1].trim();
      if(/libretas de bolsillo/i.test(text)) return q+' · 3-pack pocket';
      return q;
    }
    if(/kit magn[eé]tico/i.test(text)) return 'Kit magnético · Súper + Pendientes';
    return text.replace(/\s+-\s+Hojas.*$/i,'').replace(/Colecci[oó]n de 3 Libretas de Bolsillo\s*/i,'').trim();
  }

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
      // Intraday percentage swings are noisy at very low order counts. Keep the
      // number visible, but don't paint it as a strong red/green signal yet.
      paceWrap.classList.toggle('low-signal',orders<3);
      if(orders<3){
        paceEl.classList.remove('good','bad');
        paceEl.title='Directional only: fewer than 3 orders today';
      }else{
        paceEl.title='Compared with the prior matching weekdays at the same local time';
      }
    }
  }

  function refineDynamic(){
    document.querySelectorAll('.product,.action-product').forEach(function(el){
      if(!el.dataset.rawProduct) el.dataset.rawProduct=el.textContent;
      var next=shortProduct(el.dataset.rawProduct);
      if(el.textContent!==next) el.textContent=next;
      if(el.title!==el.dataset.rawProduct) el.title=el.dataset.rawProduct;
    });

    var attention=document.querySelector('.attention');
    var list=document.getElementById('attention');
    if(attention && list){
      var count=list.querySelectorAll('.action-item').length;
      attention.classList.toggle('single',count===1);
      attention.classList.toggle('clear',count===0);
    }
    refineSignals();
  }

  relocateAttention();
  refineDynamic();
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
