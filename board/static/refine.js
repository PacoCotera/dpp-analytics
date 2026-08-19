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
    if(note) note.textContent='Deterministic · no agent';
  }

  function refineDynamic(){
    document.querySelectorAll('.product,.action-product').forEach(function(el){
      if(!el.dataset.rawProduct) el.dataset.rawProduct=el.textContent;
      el.textContent=shortProduct(el.dataset.rawProduct);
      el.title=el.dataset.rawProduct;
    });
    var attention=document.querySelector('.attention');
    var list=document.getElementById('attention');
    if(attention && list){
      var count=list.querySelectorAll('.action-item').length;
      attention.classList.toggle('single',count===1);
      attention.classList.toggle('clear',count===0);
    }
  }

  relocateAttention();
  refineDynamic();
  var app=document.querySelector('.app');
  if(app){
    new MutationObserver(function(){refineDynamic()}).observe(app,{childList:true,subtree:true});
  }
})();
