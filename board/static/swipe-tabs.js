(() => {
  const groups = [...document.querySelectorAll('.tabs, .view-tabs')]
    .map(tablist => ({
      tablist,
      tabs: [...tablist.querySelectorAll('button[data-view]')],
    }))
    .filter(x => x.tabs.length > 1);

  if (!groups.length) return;

  const activeIndex = group => {
    const i = group.tabs.findIndex(tab => tab.classList.contains('active'));
    return i < 0 ? 0 : i;
  };

  const move = (group, delta) => {
    const from = activeIndex(group);
    const to = Math.max(0, Math.min(group.tabs.length - 1, from + delta));
    if (to === from) return;
    group.tabs[to].click();
    group.tabs[to].scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    document.body.classList.add('tab-swiped');
    window.setTimeout(() => document.body.classList.remove('tab-swiped'), 180);
  };

  for (const group of groups) {
    group.tablist.setAttribute('role', group.tablist.getAttribute('role') || 'tablist');
    group.tabs.forEach(tab => {
      tab.setAttribute('role', tab.getAttribute('role') || 'tab');
      tab.addEventListener('keydown', event => {
        if (event.key === 'ArrowRight') { event.preventDefault(); move(group, 1); }
        if (event.key === 'ArrowLeft') { event.preventDefault(); move(group, -1); }
        if (event.key === 'Home') { event.preventDefault(); group.tabs[0].click(); }
        if (event.key === 'End') { event.preventDefault(); group.tabs.at(-1).click(); }
      });
    });
  }

  let start = null;
  document.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch') return;
    if (event.target.closest('.primary-nav,.tabs,.view-tabs,.table-wrap,.order-stream,input,textarea,select,[data-no-swipe]')) return;
    start = { x: event.clientX, y: event.clientY, t: performance.now() };
  }, { passive: true });

  document.addEventListener('pointerup', event => {
    if (!start || event.pointerType !== 'touch') { start = null; return; }
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    const dt = performance.now() - start.t;
    start = null;
    if (dt > 900 || Math.abs(dx) < 58 || Math.abs(dx) < Math.abs(dy) * 1.25) return;
    move(groups[0], dx < 0 ? 1 : -1);
  }, { passive: true });
})();
