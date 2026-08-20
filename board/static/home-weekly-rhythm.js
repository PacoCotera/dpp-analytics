/* Home weekly rhythm v5
   Home stays visually quiet. Hover/focus answers only the operating questions
   needed for a repeated glance: sales, direction, orders and units.
   Tooltip placement avoids obscuring the selected week.
   The current partial week remains visible but is never compared as complete. */
(() => {
  'use strict';
  const d3 = window.d3;
  if (!d3 || !window.DPPCharts) return;

  const ink = '#26231f';
  const bar = '#d8bd95';
  const accent = '#e58b1f';
  const paper = '#f8f5ef';
  const money = new Intl.NumberFormat('en-US',{style:'currency',currency:'MXN',maximumFractionDigits:0});
  const fullMoney = value => money.format(Number(value||0)).replace('-MX$','−$').replace('MX$','$');
  const shortMoney = value => {
    const n=Number(value||0),a=Math.abs(n);
    if(a>=1e6)return `${n<0?'−':''}$${(a/1e6).toFixed(a>=1e7?0:1)}m`;
    if(a>=1e3)return `${n<0?'−':''}$${(a/1e3).toFixed(a>=1e4?0:1)}k`;
    return `${n<0?'−':''}$${Math.round(a)}`;
  };
  const pct = value => `${Number(value)>=0?'+':'−'}${Math.abs(Number(value||0)).toFixed(0)}%`;
  const parseDate = value => value ? new Date(`${String(value).slice(0,10)}T12:00:00Z`) : null;
  const esc = value => String(value||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function ensureTip(host){
    host.classList.add('dpp-chart-host');
    let tip=host.querySelector('.dpp-chart-tooltip.home-week-tooltip');
    if(!tip){
      tip=document.createElement('div');
      tip.className='dpp-chart-tooltip home-week-tooltip';
      tip.setAttribute('role','status');
      host.appendChild(tip);
    }
    return tip;
  }

  function tipShow(host,tip,target,title,rows,footer){
    const hostRect=host.getBoundingClientRect();
    const targetRect=target.getBoundingClientRect();
    tip.innerHTML=`<strong>${esc(title)}</strong>${rows.map(row=>`<span class="home-tip-row"><span class="home-tip-label">${esc(row.label)}</span><span class="home-tip-value">${esc(row.value)}</span></span>`).join('')}${footer?`<span class="home-tip-footer">${esc(footer)}</span>`:''}`;

    tip.style.visibility='hidden';
    tip.classList.add('show');
    const tipW=tip.offsetWidth||190;
    const tipH=tip.offsetHeight||120;
    const targetCenter=targetRect.left-hostRect.left+targetRect.width/2;
    const placeRight=targetCenter < hostRect.width/2;
    const gap=12;
    let left;
    if(placeRight){
      left=targetRect.right-hostRect.left+gap;
      left=Math.min(left,hostRect.width-tipW-8);
      tip.style.transform='translate(0,-50%)';
    }else{
      left=targetRect.left-hostRect.left-gap;
      left=Math.max(left,tipW+8);
      tip.style.transform='translate(-100%,-50%)';
    }
    const desiredY=targetRect.top-hostRect.top+Math.max(18,targetRect.height*.42);
    const y=Math.max(tipH/2+8,Math.min(hostRect.height-tipH/2-8,desiredY));
    tip.style.left=`${left}px`;
    tip.style.top=`${y}px`;
    tip.style.visibility='visible';
  }
  function tipHide(tip){tip.classList.remove('show')}

  function weeklyRhythm(selector,rows){
    const daily=(rows||[]).map(d=>({
      date:parseDate(d.business_date),
      value:Number(d.sales||0),
      orders:Number(d.orders||0),
      units:Number(d.units||0)
    })).filter(d=>d.date).sort((a,b)=>d3.ascending(a.date,b.date));
    const svg=d3.select(selector); if(svg.empty())return;
    svg.selectAll('*').remove();
    if(daily.length<7){svg.attr('viewBox','0 0 960 220').append('text').attr('x',480).attr('y',110).attr('text-anchor','middle').attr('class','dpp-muted').text('Not enough sales history yet.');return}

    const grouped=d3.rollups(daily,v=>({
      value:d3.sum(v,x=>x.value),
      orders:d3.sum(v,x=>x.orders),
      units:d3.sum(v,x=>x.units),
      days:v.length
    }),d=>+d3.utcMonday.floor(d.date))
      .map(([k,v])=>({week:new Date(Number(k)),...v}))
      .sort((a,b)=>d3.ascending(a.week,b.week))
      .slice(-13);

    grouped.forEach((d,i)=>{
      d.complete=d.days>=7;
      const history=grouped.slice(0,i+1).filter(x=>x.complete).slice(-4);
      d.signal=d.complete&&history.length?d3.mean(history,x=>x.value):null;
      d.previous=i>0?grouped[i-1]:null;
    });

    const node=svg.node(),host=node.parentElement,tip=ensureTip(host);
    const rect=node.getBoundingClientRect();
    const compact=window.innerWidth<=720;
    const width=Math.max(compact?520:760,Math.round(rect.width||960));
    const height=Math.max(compact?230:320,Math.round(rect.height||420));
    const m={top:24,right:compact?14:62,bottom:42,left:compact?54:64};
    const innerW=width-m.left-m.right,innerH=height-m.top-m.bottom;
    svg.classed('dpp-chart',true).attr('viewBox',`0 0 ${width} ${height}`).attr('preserveAspectRatio','xMidYMid meet').attr('role','img').attr('aria-label','Thirteen weeks of weekly sales with a four-week average; current week is partial');
    const plot=svg.append('g').attr('transform',`translate(${m.left},${m.top})`);
    const x=d3.scaleBand().domain(grouped.map(d=>+d.week)).range([0,innerW]).padding(.24);
    const ymax=d3.max(grouped,d=>Math.max(d.value,d.signal||0))||1;
    const y=d3.scaleLinear().domain([0,ymax]).nice(4).range([innerH,0]);

    plot.append('g').attr('class','dpp-grid').call(d3.axisLeft(y).ticks(4).tickSize(-innerW).tickFormat(''));
    plot.append('g').attr('class','dpp-axis').call(d3.axisLeft(y).ticks(4).tickSize(0).tickPadding(10).tickFormat(shortMoney)).call(g=>g.select('.domain').remove());

    const defs=svg.append('defs');
    const pid='home-week-wtd';
    const pattern=defs.append('pattern').attr('id',pid).attr('width',8).attr('height',8).attr('patternUnits','userSpaceOnUse').attr('patternTransform','rotate(45)');
    pattern.append('rect').attr('width',8).attr('height',8).attr('fill','#ead7b9').attr('opacity',.46);
    pattern.append('line').attr('x1',0).attr('y1',0).attr('x2',0).attr('y2',8).attr('stroke',accent).attr('stroke-width',1.5).attr('opacity',.48);

    const bars=plot.selectAll('.dpp-bar').data(grouped).join('rect').attr('class','dpp-bar')
      .attr('x',d=>x(+d.week)).attr('width',x.bandwidth()).attr('y',d=>y(d.value)).attr('height',d=>Math.max(1,innerH-y(d.value))).attr('rx',3)
      .attr('fill',d=>d.complete?bar:`url(#${pid})`).attr('opacity',d=>d.complete?.82:1);

    const partial=grouped.findLast(d=>!d.complete);
    if(partial){
      plot.append('text').attr('x',x(+partial.week)+x.bandwidth()/2).attr('y',Math.max(12,y(partial.value)-8)).attr('text-anchor','middle')
        .attr('fill',accent).attr('font-size',10).attr('font-weight',800).attr('letter-spacing','.08em').text('WTD');
    }

    const signalData=grouped.filter(d=>d.signal!=null);
    if(signalData.length>1){
      const lineGen=d3.line().x(d=>x(+d.week)+x.bandwidth()/2).y(d=>y(d.signal)).curve(d3.curveMonotoneX);
      plot.append('path').datum(signalData).attr('d',lineGen).attr('fill','none').attr('stroke',paper).attr('stroke-width',7).attr('stroke-linecap','round').attr('stroke-linejoin','round');
      plot.append('path').datum(signalData).attr('d',lineGen).attr('fill','none').attr('stroke',ink).attr('stroke-width',3.2).attr('stroke-linecap','round').attr('stroke-linejoin','round');
      if(!compact){
        const last=signalData[signalData.length-1];
        plot.append('text').attr('x',x(+last.week)+x.bandwidth()/2+9).attr('y',Math.max(12,y(last.signal)-10))
          .attr('class','dpp-muted').attr('font-weight',750).text('4W avg');
      }
    }

    const tickEvery=Math.max(1,Math.ceil(grouped.length/5));
    const ticks=grouped.filter((d,i)=>i===0||i===grouped.length-1||i%tickEvery===0).map(d=>+d.week);
    plot.append('g').attr('class','dpp-axis').attr('transform',`translate(0,${innerH})`)
      .call(d3.axisBottom(x).tickValues(ticks).tickSize(0).tickPadding(12).tickFormat(v=>d3.utcFormat('%b %-d')(new Date(Number(v)))))
      .call(g=>g.select('.domain').attr('stroke','#cfc5b7'));

    bars.attr('tabindex',0).on('pointerenter pointermove focus',function(event,d){
      const tipRows=[{label:'Sales',value:fullMoney(d.value)}];
      if(d.complete){
        if(d.previous&&d.previous.complete&&d.previous.value>0)tipRows.push({label:'LW',value:pct(100*(d.value-d.previous.value)/d.previous.value)});
        if(d.signal&&d.signal>0)tipRows.push({label:'4W',value:pct(100*(d.value-d.signal)/d.signal)});
      }else{
        tipRows.push({label:'WTD',value:'partial'});
      }
      tipShow(host,tip,this,`Week of ${d3.utcFormat('%b %-d')(d.week)}`,tipRows,`${d.orders.toLocaleString('en-US')} orders · ${d.units.toLocaleString('en-US')} units`);
    }).on('pointerleave blur',()=>tipHide(tip));

    if(node.__dppWeeklyResize)window.removeEventListener('resize',node.__dppWeeklyResize);
    let timer;
    node.__dppWeeklyResize=()=>{clearTimeout(timer);timer=setTimeout(()=>weeklyRhythm(selector,rows),120)};
    window.addEventListener('resize',node.__dppWeeklyResize,{passive:true});
  }

  window.DPPCharts.homeRhythm=weeklyRhythm;
  document.addEventListener('DOMContentLoaded',()=>{
    const title=document.querySelector('body.home-page .spark-card .section-title');
    const sub=document.querySelector('body.home-page .spark-card .section-sub');
    if(title)title.textContent='Business rhythm';
    if(sub)sub.textContent='13 weeks · weekly sales · 4-week average · current week partial';
  });
})();
