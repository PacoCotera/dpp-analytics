/* Today clarity pass: static-only compatibility layer.
   Runtime ownership belongs exclusively to today-operating-v2.js.
   No fetches, MutationObservers, selector rewrites, or DOM reconstruction here. */
(() => {
  if (!document.body.classList.contains('today-shell')) return;
  if (document.documentElement.classList.contains('wall-mode')) return;

  const style = document.createElement('style');
  style.id = 'today-static-clarity';
  style.textContent = `
    /* Keep the primary Today read dense: selector -> sales -> operating context. */
    html:not(.wall-mode) .today-shell.today-operating-v3 .today-operating-main .hero-main{
      display:grid!important;
      grid-template-rows:auto auto auto!important;
      align-content:start!important;
      row-gap:4px!important;
    }
    html:not(.wall-mode) .today-shell.today-operating-v3 .today-operating-main .hero-sales{
      display:flex!important;
      align-items:center!important;
      align-self:start!important;
      justify-self:start!important;
      visibility:visible!important;
      opacity:1!important;
      position:relative!important;
      z-index:2!important;
      min-height:0!important;
      margin:6px 0 8px!important;
    }
    html:not(.wall-mode) .today-shell.today-operating-v3 .today-operating-main .hero-bottom{
      align-self:start!important;
      width:100%!important;
      margin-top:0!important;
    }
    @media(min-width:981px){
      html:not(.wall-mode) .today-shell.today-operating-v3 .today-operating-main .hero-main{
        padding-top:16px!important;
        padding-bottom:15px!important;
      }
      html:not(.wall-mode) .today-shell.today-operating-v3 .today-operating-main .hero-sales{
        font-size:clamp(68px,5.6vw,90px)!important;
        line-height:.82!important;
      }
      html:not(.wall-mode) .today-shell.today-operating-v3 .today-operating-main .hero-bottom{
        max-width:720px!important;
      }
    }

    /* Stable copy from first paint through every base-render refresh. */
    html:not(.wall-mode) .today-shell #productsTitle{font-size:0!important}
    html:not(.wall-mode) .today-shell #productsTitle:after{
      content:'Products sold today';
      font-size:13.5px;
      font-weight:800;
      letter-spacing:.01em;
    }
    html:not(.wall-mode) .today-shell[data-day-mode='closed'] #productsTitle:after{content:'Products sold that day'}
    html:not(.wall-mode) .today-shell #productsSub{font-size:0!important}
    html:not(.wall-mode) .today-shell #productsSub:after{
      content:'Sales mix by product';
      font-size:10px;
      color:var(--muted);
    }
    html:not(.wall-mode) .today-shell #latestLabel{font-size:0!important}
    html:not(.wall-mode) .today-shell #latestLabel:after{
      content:'Latest sale';
      font-size:8.5px;
      font-weight:830;
      letter-spacing:.13em;
      text-transform:uppercase;
      color:var(--muted);
    }

    @media(max-width:640px){
      html:not(.wall-mode) .today-shell.today-operating-v3 .today-operating-main .hero-sales{
        min-height:0!important;
      }
    }
  `;
  document.head.appendChild(style);
})();