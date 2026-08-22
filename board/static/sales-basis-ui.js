(() => {
  'use strict';

  const HIST_BASIS = 'shopper spend incl. IVA';
  const HIST_SOURCE = 'Amazon Sales & Traffic';

  function text(id, value) {
    const node = document.getElementById(id);
    if (node && node.textContent !== value) node.textContent = value;
  }

  function range() {
    return document.querySelector('.sales-range button.active')?.dataset.range || '12m';
  }

  function clarifyStaticSignals() {
    const mtd = document.getElementById('mtdLabel');
    if (mtd && !/incl\. IVA/i.test(mtd.textContent)) mtd.textContent = `${mtd.textContent.trim()} · incl. IVA`;
    const ytd = document.getElementById('ytdLabel');
    if (ytd && !/incl\. IVA/i.test(ytd.textContent)) ytd.textContent = `${ytd.textContent.trim()} · incl. IVA`;
  }

  function clarifyChart() {
    const selected = range();
    const copy = {
      full: ['Full shopper-spend history', `Monthly ${HIST_BASIS} · ${HIST_SOURCE} · year boundaries`],
      '12m': ['Monthly shopper spend', `12 months · incl. IVA · ${HIST_SOURCE} · current month actual + run rate`],
      '90d': ['Weekly shopper spend', `90 days · incl. IVA · ${HIST_SOURCE} · current week may be partial`],
      '28d': ['Daily shopper spend', `28 days · incl. IVA · ${HIST_SOURCE} · week and month boundaries`],
    }[selected];
    if (copy) {
      text('salesChartTitle', copy[0]);
      text('salesChartSub', copy[1]);
    }

    document.querySelectorAll('.sales-chart-kpi-label').forEach(node => {
      const raw = node.textContent.trim();
      const replacements = {
        'Full history sales': 'Full history shopper spend',
        '90D sales': '90D shopper spend',
        '28D sales': '28D shopper spend',
      };
      const next = replacements[raw] || raw.replace(/ MTD sales$/, ' MTD shopper spend');
      if (next !== raw) node.textContent = next;
    });
    document.querySelectorAll('.sales-chart-kpi-note').forEach(node => {
      if (/reconciled period|full history|month to date|last 90 days|28-day average/i.test(node.textContent) && !/incl\. IVA/i.test(node.textContent)) {
        node.textContent = `${node.textContent.trim()} · incl. IVA`;
      }
    });
  }

  function clarifyTooltips() {
    document.querySelectorAll('.sales-period-tooltip .home-tip-label').forEach(node => {
      if (node.textContent.trim() === 'Sales' || /net sales ex IVA/i.test(node.textContent)) node.textContent = 'Shopper spend incl. IVA';
    });
  }

  function apply() {
    clarifyStaticSignals();
    clarifyChart();
    clarifyTooltips();
  }

  const observer = new MutationObserver(() => queueMicrotask(apply));
  const start = () => {
    apply();
    observer.observe(document.body, {subtree: true, childList: true, characterData: true});
    document.querySelector('.sales-range')?.addEventListener('click', () => requestAnimationFrame(apply));
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once: true});
  else start();
})();
