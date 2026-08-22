(() => {
  'use strict';

  function setText(id, value) {
    const node = document.getElementById(id);
    if (node && node.textContent !== value) node.textContent = value;
  }

  function appendBasis(id, suffix) {
    const node = document.getElementById(id);
    if (!node) return;
    const raw = node.textContent.trim();
    if (raw && !/ex IVA/i.test(raw)) node.textContent = `${raw} · ${suffix}`;
  }

  function clarifyHistoricalTooltipLabels() {
    document.querySelectorAll('.dpp-chart-tooltip .home-tip-label').forEach(node => {
      if (node.textContent.trim() === 'Sales') node.textContent = 'Net sales ex IVA';
    });
  }

  function home() {
    setText('sales28Note', 'net ex IVA · Sales & Traffic');
    clarifyHistoricalTooltipLabels();
  }

  function catalog() {
    const head = document.getElementById('portfolioHead');
    const third = head?.children?.[2];
    if (third && !/ex IVA/i.test(third.textContent)) third.textContent = '28D net sales ex IVA';
    const read = document.getElementById('portfolioRead');
    if (read && read.textContent && !/net sales/i.test(read.textContent)) {
      read.setAttribute('title', 'Portfolio amount is reconciled Amazon Sales & Traffic net sales ex IVA.');
    }
    appendBasis('portfolioBasis', 'net sales ex IVA · Amazon Sales & Traffic');
    const freshness = document.getElementById('freshness');
    if (freshness && !/net sales/i.test(freshness.textContent)) {
      freshness.textContent = `${freshness.textContent.trim()} · net sales ex IVA`;
    }
    document.querySelectorAll('.child-head span:nth-child(3)').forEach(node => {
      if (!/ex IVA/i.test(node.textContent)) node.textContent = '28D net sales ex IVA';
    });
  }

  function product() {
    setText('chartSub', `Net sales ex IVA · reconciled Amazon Sales & Traffic · daily + seven-day signal`);
    const summary = document.getElementById('orderSummary');
    if (summary && !/incl\. IVA/i.test(summary.textContent)) summary.textContent = `${summary.textContent.trim()} · shopper spend incl. IVA`;
    const econ = document.getElementById('econRead');
    if (econ && / of sales\./i.test(econ.textContent)) econ.textContent = econ.textContent.replace(/ of sales\./i, ' of net sales ex IVA.');
    clarifyHistoricalTooltipLabels();
  }

  function trajectory() {
    clarifyHistoricalTooltipLabels();
    document.querySelectorAll('#horizons .metric-label, #horizons .horizon-label').forEach(node => {
      if (/sales/i.test(node.textContent) && !/ex IVA/i.test(node.textContent)) node.textContent = `${node.textContent.trim()} · ex IVA`;
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
