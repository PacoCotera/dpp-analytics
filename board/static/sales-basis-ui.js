(() => {
  'use strict';

  const HIST_BASIS = 'net sales ex IVA';
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
    if (mtd && !/ex IVA/i.test(mtd.textContent)) mtd.textContent = `${mtd.textContent.trim()} · net ex IVA`;
    const ytd = document.getElementById('ytdLabel');
    if (ytd && !/ex IVA/i.test(ytd.textContent)) ytd.textContent = `${ytd.textContent.trim()} · net ex IVA`;
  }

  function clarifyChart() {
    const selected = range();
    const copy = {
      full: ['Full net-sales history', `Monthly ${HIST_BASIS} · ${HIST_SOURCE} · year boundaries`],
      '12m': ['Monthly net sales ex IVA', `12 months · ${HIST_SOURCE} · ${HIST_BASIS} · current month actual + run rate`],
      '90d': ['Weekly net sales ex IVA', `90 days · ${HIST_SOURCE} · ${HIST_BASIS} · current week may be partial`],
      '28d': ['Daily net sales ex IVA', `28 days · ${HIST_SOURCE} · ${HIST_BASIS} · week and month boundaries`],
    }[selected];
    if (copy) {
      text('salesChartTitle', copy[0]);
      text('salesChartSub', copy[1]);
    }

    document.querySelectorAll('.sales-chart-kpi-label').forEach(node => {
      const raw = node.textContent.trim();
      const replacements = {
        'Full history sales': 'Full history net sales',
        '90D sales': '90D net sales',
        '28D sales': '28D net sales',
      };
      let next = replacements[raw] || raw.replace(/ MTD sales$/, ' MTD net sales');
      if (next !== raw) node.textContent = next;
    });
    document.querySelectorAll('.sales-chart-kpi-note').forEach(node => {
      if (/reconciled period|full history|month to date|last 90 days|28-day average/i.test(node.textContent) && !/ex IVA/i.test(node.textContent)) {
        node.textContent = `${node.textContent.trim()} · ex IVA`;
      }
    });
  }

  function clarifyTooltips() {
    document.querySelectorAll('.sales-period-tooltip .home-tip-label').forEach(node => {
      if (node.textContent.trim() === 'Sales') node.textContent = 'Net sales ex IVA';
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
