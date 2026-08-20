/* today-responsive-v2
   Today controls and rhythm recompose from measured container width, never UA strings.
   Day selection lives inside the sales panel; rhythm uses the available plot width. */
(() => {
  'use strict';
  if (!document.body.classList.contains('today-shell')) return;

  const d3 = window.d3;
  if (!d3) return;

  const style = document.createElement('style');
  style.textContent = `
    /* Day selection belongs to the sales object, not to page chrome. */
    .today-hero-head{display:grid;grid-template-columns:auto minmax(238px,318px);justify-content:space-between;align-items:start;gap:18px;position:relative;z-index:2}
    .today-hero-head .eyebrow{padding-top:8px}
    .today-hero-head .day-picker{display:grid!important;grid-template-columns:repeat(7,minmax(0,1fr))!important;gap:5px!important;width:100%!important;margin:0!important;padding:0!important;border:0!important;overflow:visible!important}
    .today-hero-head .day-choice{display:grid!important;place-items:center!important;align-content:center!important;min-width:0!important;width:100%!important;aspect-ratio:1/1!important;min-height:0!important;padding:3px!important;border:1px solid var(--line)!important;border-radius:11px!important;background:rgba(248,244,237,.7)!important;box-shadow:none!important;text-align:center!important;overflow:hidden!important}
    .today-hero-head .day-choice b{font-size:12px!important;line-height:1!important;color:var(--ink)!important;font-weight:820!important}
    .today-hero-head .day-choice span{font-size:8.5px!important;line-height:1!important;color:var(--muted)!important;margin-top:4px!important;font-variant-numeric:tabular-nums}
    .today-hero-head .day-choice.active{background:var(--ink)!important;border-color:var(--ink)!important}
    .today-hero-head .day-choice.active b,.today-hero-head .day-choice.active span{color:#fff8ed!important}
    .today-hero-head .day-choice.live.active{background:var(--accent)!important;border-color:var(--accent)!important}
    .today-hero-head .day-choice.live.active b,.today-hero-head .day-choice.live.active span{color:#2b1804!important}
    .today-hero-head .day-choice:nth-child(n+8){display:none!important}
    .today-hero-head .day-choice.partial:after{display:none!important}

    /* Product title is one visual state, so base refreshes cannot visibly flicker it. */
    #productsTitle{font-size:0!important}
    #productsTitle:after{font-size:16px;font-weight:830;letter-spacing:.03em;content:'Products sold today'}
    body[data-day-mode='closed'] #productsTitle:after{content:'Products sold that day'}

    /* Recent rhythm should be dense and use its panel rather than preserving a desktop canvas. */
    #rhythm{width:100%!important;height:auto!important;min-height:0!important;overflow:visible}
    .content-grid> .panel:first-child{overflow:hidden}
    .content-grid> .panel:first-child .panel-head{margin-bottom:4px}
    .today-rhythm-week{stroke:#c9c1b7;stroke-width:.8;opacity:.46;shape-rendering:crispEdges}
    .today-rhythm-month{stroke:var(--accent);stroke-width:1.25;opacity:.78;shape-rendering:crispEdges}
    .today-rhythm-month-label{fill:#9b641d;font:720 9px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:.05em}

    .hero-main[data-compact='1'] .today-hero-head{grid-template-columns:1fr;gap:9px}
    .hero-main[data-compact='1'] .today-hero-head .eyebrow{padding-top:0}
    .hero-main[data-compact='1'] .day-picker{max-width:none!important}
    .hero-main[data-compact='1'] .day-choice{border-radius:9px!important}

    @media(max-width:640px){
      .today-hero-head{grid-template-columns:1fr;gap:8px}
      .today-hero-head .eyebrow{padding-top:0}
      .today-hero-head .day-picker{gap:4px!important}
      .today-hero-head .day-choice{border-radius:9px!important;padding:2px!important}
      .today-hero-head .day-choice b{font-size:11px!important}
      .today-hero-head .day-choice span{font-size:8px!important;margin-top:3px!important}
      #productsTitle:after{font-size:15px}
    }
    .wall-mode .today-hero-head .day-picker{display:none!important}
  `;
  document.head.appendChild(style);

  const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const shortMoney = value => {
    const n = Number(value || 0), a = Math.abs(n);
    if (a >= 1000000) return `${n < 0 ? '−' : ''}$${(a / 1000000).toFixed(a >= 10000000 ? 0 : 1)}m`;
    if (a >= 1000) return `${n < 0 ? '−' : ''}$${(a / 1000).toFixed(a >= 10000 ? 0 : 1)}k`;
    return `${n < 0 ? '−' : ''}$${Math.round(a)}`;
  };
  const fullMoney = value => '$' + nf.format(Math.round(Number(value || 0)));
  const parseDate = value => value ? new Date(`${String(value).slice(0,10)}T12:00:00Z`) : null;
  const weekdayLetter = date => ['S','M','T','W','T','F','S'][date.getUTCDay()];

  function placeDayPicker() {
    const hero = document.querySelector('.hero-main');
    const picker = document.getElementById('dayPicker');
    const eyebrow = document.getElementById('salesEyebrow');
    if (!hero || !picker || !eyebrow || document.documentElement.classList.contains('wall-mode')) return false;
    let head = hero.querySelector('.today-hero-head');
    if (!head) {
      head = document.createElement('div');
      head.className = 'today-hero-head';
      hero.insertBefore(head, hero.firstChild);
      head.append(eyebrow, picker);
    }
    return true;
  }

  function labelDayPicker() {
    const choices = [...document.querySelectorAll('#dayPicker .day-choice')];
    choices.forEach(button => {
      const date = parseDate(button.dataset.date);
      if (!date) return;
      const b = button.querySelector('b'), span = button.querySelector('span');
      const long = new Intl.DateTimeFormat('en-US',{weekday:'long',month:'short',day:'numeric',timeZone:'UTC'}).format(date);
      if (b) b.textContent = weekdayLetter(date);
      if (span) span.textContent = String(date.getUTCDate());
      button.title = long;
      button.setAttribute('aria-label', `${long}${button.classList.contains('live') ? ', Today' : ''}`);
    });
    const active = document.querySelector('#dayPicker .day-choice.active');
    document.body.dataset.dayMode = active?.classList.contains('live') ? 'live' : 'closed';
  }

  function measureHero() {
    const hero = document.querySelector('.hero-main');
    if (!hero) return;
    hero.dataset.compact = hero.getBoundingClientRect().width < 560 ? '1' : '0';
  }

  function ensureTip(host) {
    host.classList.add('dpp-chart-host');
    let tip = host.querySelector('.dpp-chart-tooltip.today-rhythm-tip');
    if (!tip) {
      host.querySelectorAll('.dpp-chart-tooltip').forEach(node => node.remove());
      tip = document.createElement('div');
      tip.className = 'dpp-chart-tooltip home-week-tooltip today-rhythm-tip';
      tip.setAttribute('role','status');
      host.appendChild(tip);
    }
    return tip;
  }

  function showTip(host, tip, target, d) {
    if (host.getBoundingClientRect().width < 640) return;
    const hr = host.getBoundingClientRect(), tr = target.getBoundingClientRect();
    tip.innerHTML = `<strong>${d3.utcFormat('%a, %b %-d')(d.date)}</strong><span class="home-tip-row"><span class="home-tip-label">Sales</span><span class="home-tip-value">${fullMoney(d.value)}</span></span><span class="home-tip-footer">${nf.format(d.orders)} orders · ${nf.format(d.units)} units</span>`;
    tip.style.visibility = 'hidden'; tip.classList.add('show');
    const tw = tip.offsetWidth || 180, th = tip.offsetHeight || 90;
    const center = tr.left - hr.left + tr.width / 2;
    const right = center < hr.width / 2;
    const left = right ? Math.min(tr.right - hr.left + 10, hr.width - tw - 8) : Math.max(tr.left - hr.left - 10, tw + 8);
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(th/2+8, Math.min(hr.height-th/2-8, tr.top-hr.top+tr.height*.45))}px`;
    tip.style.transform = right ? 'translate(0,-50%)' : 'translate(-100%,-50%)';
    tip.style.visibility = 'visible';
  }

  let lastRhythm = null;
  function responsiveRhythm(selector, rows, opts = {}) {
    const svg = d3.select(selector);
    if (svg.empty()) return;
    const node = svg.node(), host = node.parentElement;
    const rect = host.getBoundingClientRect();
    const width = Math.max(300, Math.round(rect.width));
    const dense = width < 560;
    const height = dense ? 205 : width < 900 ? 190 : 178;
    const m = { top: 14, right: 8, bottom: 30, left: dense ? 46 : 52 };
    const innerW = width - m.left - m.right, innerH = height - m.top - m.bottom;
    const data = (rows || []).map(r => ({
      ...r, date: parseDate(r.business_date), value: Number(r.sales || 0),
      orders: Number(r.orders || 0), units: Number(r.units || 0)
    })).filter(d => d.date).sort((a,b) => d3.ascending(a.date,b.date));
    svg.selectAll('*').remove();
    svg.attr('viewBox',`0 0 ${width} ${height}`).attr('preserveAspectRatio','xMidYMid meet').attr('role','img').attr('aria-label','Recent daily sales rhythm');
    if (!data.length) return;
    const plot = svg.append('g').attr('transform',`translate(${m.left},${m.top})`);
    const x = d3.scaleBand().domain(data.map(d => +d.date)).range([0,innerW]).padding(data.length <= 8 ? .22 : .28);
    const y = d3.scaleLinear().domain([0,d3.max(data,d=>d.value)||1]).nice(4).range([innerH,0]);
    plot.append('g').attr('class','dpp-grid').call(d3.axisLeft(y).ticks(4).tickSize(-innerW).tickFormat(''));
    plot.append('g').attr('class','dpp-axis').call(d3.axisLeft(y).ticks(4).tickSize(0).tickPadding(8).tickFormat(shortMoney)).call(g=>g.select('.domain').remove());

    const selected = data[data.length-1]?.date;
    const bars = plot.selectAll('.dpp-bar').data(data).join('rect').attr('class','dpp-bar')
      .attr('x',d=>x(+d.date)).attr('width',x.bandwidth()).attr('y',d=>y(d.value)).attr('height',d=>Math.max(1,innerH-y(d.value)))
      .attr('rx',Math.min(4,x.bandwidth()/4)).attr('fill',d=>{
        const day=d.date.getUTCDay();
        if (opts.live && +d.date === +selected) return '#e58b1f';
        return day===0||day===6 ? '#d8c09b' : '#b78b4d';
      });

    data.forEach((d,i)=>{
      if (i===0) return;
      const prev=data[i-1];
      if (d.date.getUTCDay()===1) {
        const divider=x(+d.date)-(x.step()-x.bandwidth())/2;
        plot.append('line').attr('class','today-rhythm-week').attr('x1',divider).attr('x2',divider).attr('y1',0).attr('y2',innerH);
      }
      if (d.date.getUTCMonth()!==prev.date.getUTCMonth()) {
        const divider=x(+d.date)-(x.step()-x.bandwidth())/2;
        plot.append('line').attr('class','today-rhythm-month').attr('x1',divider).attr('x2',divider).attr('y1',0).attr('y2',innerH);
        plot.append('text').attr('class','today-rhythm-month-label').attr('x',divider+5).attr('y',10).text(d3.utcFormat('%b')(d.date).toUpperCase());
      }
    });

    let ticks;
    if (data.length <= 8) ticks=data;
    else {
      const target = width < 520 ? 4 : width < 850 ? 5 : 7;
      const step = Math.max(1,Math.ceil(data.length/target));
      ticks=data.filter((d,i)=>i===0||i===data.length-1||i%step===0);
    }
    plot.append('g').attr('class','dpp-axis').attr('transform',`translate(0,${innerH})`)
      .call(d3.axisBottom(x).tickValues(ticks.map(d=>+d.date)).tickSize(0).tickPadding(9).tickFormat(v=>{
        const d=new Date(Number(v));
        return data.length<=8?d3.utcFormat('%a')(d):d3.utcFormat('%-d')(d);
      })).call(g=>g.select('.domain').attr('stroke','#cfc5b7'));

    const tip=ensureTip(host);
    bars.attr('tabindex',0).on('pointerenter pointermove focus',function(event,d){showTip(host,tip,this,d);}).on('pointerleave blur',()=>tip.classList.remove('show'));
    lastRhythm={selector,rows,opts};
  }

  function installResponsiveChart() {
    if (!window.DPPCharts || typeof window.DPPCharts.dailyRhythm !== 'function') return false;
    if (window.DPPCharts.dailyRhythm.__todayResponsiveV2) return true;
    responsiveRhythm.__todayResponsiveV2 = true;
    window.DPPCharts.dailyRhythm = responsiveRhythm;
    const active = document.querySelector('.period.active');
    if (active) active.click();
    return true;
  }

  let resizeTimer;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer=setTimeout(()=>{
      measureHero();
      if (lastRhythm) responsiveRhythm(lastRhythm.selector,lastRhythm.rows,lastRhythm.opts);
    },80);
  }

  function refreshStructure() {
    placeDayPicker();
    labelDayPicker();
    measureHero();
  }

  function init() {
    refreshStructure();
    let attempts=0;
    const chartTimer=setInterval(()=>{attempts+=1;if(installResponsiveChart()||attempts>40)clearInterval(chartTimer);},50);
    const picker=document.getElementById('dayPicker');
    if (picker) new MutationObserver(refreshStructure).observe(picker,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
    const hero=document.querySelector('.hero-main');
    const rhythmHost=document.getElementById('rhythm')?.parentElement;
    if (window.ResizeObserver) {
      const ro=new ResizeObserver(onResize);
      if(hero)ro.observe(hero);
      if(rhythmHost)ro.observe(rhythmHost);
    } else window.addEventListener('resize',onResize,{passive:true});
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
