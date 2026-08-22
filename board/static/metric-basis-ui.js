(() => {
  'use strict';

  function setText(id, value) {
    const node = document.getElementById(id);
    if (node && node.textContent !== value) node.textContent = value;
  }

  function setNodeText(node, value) {
    if (node && node.textContent !== value) node.textContent = value;
  }

  function clarifyHistoricalTooltipLabels() {
    document.querySelectorAll('.dpp-chart-tooltip .home-tip-label').forEach((node) => {
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
    setNodeText(head?.children?.[2], '28D shopper spend incl. IVA');
    const read = document.getElementById('portfolioRead');
    const title =
      'Portfolio amount is reconciled Amazon Sales & Traffic shopper spend including IVA. Net revenue ex IVA is in Finance.';
    if (read && read.getAttribute('title') !== title) read.setAttribute('title', title);
    setText(
      'portfolioBasis',
      '28-day shopper spend incl. IVA · Amazon Sales & Traffic + current FBA availability',
    );
    setText('freshness', 'MXN · historical/product sales = shopper spend incl. IVA · Amazon Sales & Traffic');
    document.querySelectorAll('.child-head span:nth-child(3)').forEach((node) => {
      setNodeText(node, '28D shopper spend incl. IVA');
    });
  }

  function product() {
    setText(
      'chartSub',
      'Shopper spend incl. IVA · reconciled Amazon Sales & Traffic · daily + seven-day signal',
    );
    const summary = document.getElementById('orderSummary');
    if (summary && !/incl\. IVA/i.test(summary.textContent))
      summary.textContent = `${summary.textContent.trim()} · shopper spend incl. IVA`;
    const econ = document.getElementById('econRead');
    if (econ && /net sales ex IVA/i.test(econ.textContent))
      econ.textContent = econ.textContent.replace(/net sales ex IVA/gi, 'shopper spend incl. IVA');
    clarifyHistoricalTooltipLabels();
  }

  function trajectory() {
    clarifyHistoricalTooltipLabels();
    document.querySelectorAll('#horizons .metric-label, #horizons .horizon-label').forEach((node) => {
      if (/sales/i.test(node.textContent) && !/incl\. IVA/i.test(node.textContent))
        node.textContent = `${node.textContent.trim()} · incl. IVA`;
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
    queueMicrotask(() => {
      queued = false;
      apply();
    });
  };

  const start = () => {
    apply();
    new MutationObserver(queue).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
