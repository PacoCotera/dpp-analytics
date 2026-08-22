(() => {
  'use strict';

  function setText(id, value) {
    const node = document.getElementById(id);
    if (node && node.textContent !== value) node.textContent = value;
  }

  function clarifyHistoricalTooltipLabels() {
    document.querySelectorAll('.dpp-chart-tooltip .home-tip-label').forEach(node => {
      if (node.textContent.trim() === 'Sales' || /net sales ex IVA/i.test(node.textContent)) {
        node.textContent = 'Shopper spend incl. IVA';
      }
    });
  }

  function home() {
    setText('sales28Note', 'incl. IVA · Sales & Traffic');
    clarifyHistoricalTooltipLabels();
  }

  function catalog() {
    const head = document.getElementById('portfolioHead');
    const third = head?.children?.[2];
    if (third) third.textContent = '28D shopper spend incl. IVA';
    const read = document.getElementById('portfolioRead');
    if (read) read.setAttribute('title', 'Portfolio amount is reconciled Amazon Sales & Traffic shopper spend including IVA. Net revenue ex IVA is in Finance.');
    const basis = document.getElementById('portfolioBasis');
    if (basis) basis.textContent = '28-day shopper spend incl. IVA · Amazon Sales & Traffic + current FBA availability';
    const freshness = document.getElementById('freshness');
    if (freshness) freshness.textContent = 'MXN · historical/product sales = shopper spend incl. IVA · Amazon Sales & Traffic';
    document.querySelectorAll('.child-head span:nth-child(3)').forEach(node => {
      node.textContent = '28D shopper spend incl. IVA';
    });
  }

  function product() {
    setText('chartSub', 'Shopper spend incl. IVA · reconciled Amazon Sales & Traffic · daily + seven-day signal');
    const summary = document.getElementById('orderSummary');
    if (summary && !/incl\. IVA/i.test(summary.textContent)) summary.textContent = `${summary.textContent.trim()} · shopper spend incl. IVA`;
    const econ = document.getElementById('econRead');
    if (econ && /net sales ex IVA/i.test(econ.textContent)) econ.textContent = econ.textContent.replace(/net sales ex IVA/ig, 'shopper spend incl. IVA');
    clarifyHistoricalTooltipLabels();
  }

  function trajectory() {
    clarifyHistoricalTooltipLabels();
    document.querySelectorAll('#horizons .metric-label, #horizons .horizon-label').forEach(node => {
      if (/sales/i.test(node.textContent) && !/incl\. IVA/i.test(node.textContent)) node.textContent = `${node.textContent.trim()} · incl. IVA`;
    });
  }

  function apply() {
    const path = location.pathname.replace(/\/$/, '') || '/';
    if (path === '/') home();
    else if (path === '/catalog') catalog();
    else if (path === '/product') product();
    else if (path === '/trajectory') trajectory();
  }

  let queued = false;
  const queue = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; apply(); });
  };

  const start = () => {
    apply();
    new MutationObserver(queue).observe(document.body, {subtree: true, childList: true, characterData: true});
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once: true});
  else start();
})();
