(() => {
  const groups = [...document.querySelectorAll('.tabs, .view-tabs')]
    .map(tablist => ({
      tablist,
      tabs: [...tablist.querySelectorAll('button[data-view]')],
    }))
    .filter(x => x.tabs.length > 1);

  const primaryLinks = [...document.querySelectorAll('.primary-nav a:not(.disabled)')]
    .filter(link => link.href && new URL(link.href, location.href).origin === location.origin);

  const activeIndex = group => {
    const i = group.tabs.findIndex(tab => tab.classList.contains('active'));
    return i < 0 ? 0 : i;
  };

  const moveTab = (group, delta) => {
    const from = activeIndex(group);
    const to = from + delta;
    if (to < 0 || to >= group.tabs.length) return false;
    group.tabs[to].click();
    group.tabs[to].scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    document.body.classList.add('tab-swiped');
    window.setTimeout(() => document.body.classList.remove('tab-swiped'), 180);
    return true;
  };

  const currentPrimaryIndex = () => {
    const explicit = primaryLinks.findIndex(link => link.classList.contains('active'));
    if (explicit >= 0) return explicit;
    const here = location.pathname.replace(/\/$/, '') || '/';
    return primaryLinks.findIndex(link => {
      const path = new URL(link.href, location.href).pathname.replace(/\/$/, '') || '/';
      return path === here;
    });
  };

  const movePrimary = delta => {
    const from = currentPrimaryIndex();
    if (from < 0) return false;
    const to = from + delta;
    if (to < 0 || to >= primaryLinks.length) return false;
    const target = primaryLinks[to];
    document.body.classList.add('page-swiped');
    window.setTimeout(() => { location.assign(target.href); }, 70);
    return true;
  };

  for (const group of groups) {
    group.tablist.setAttribute('role', group.tablist.getAttribute('role') || 'tablist');
    group.tabs.forEach(tab => {
      tab.setAttribute('role', tab.getAttribute('role') || 'tab');
      tab.addEventListener('keydown', event => {
        if (event.key === 'ArrowRight') { event.preventDefault(); moveTab(group, 1); }
        if (event.key === 'ArrowLeft') { event.preventDefault(); moveTab(group, -1); }
        if (event.key === 'Home') { event.preventDefault(); group.tabs[0].click(); }
        if (event.key === 'End') { event.preventDefault(); group.tabs.at(-1).click(); }
      });
    });
  }

  let start = null;
  const isMobile = () => matchMedia('(max-width: 760px)').matches;
  const excluded = '.primary-nav,.tabs,.view-tabs,.filters,.periods,.chart-tools,.table-wrap,.order-stream,.catalog-toolbar,input,textarea,select,button,a,svg,[data-no-swipe]';

  document.addEventListener('pointerdown', event => {
    if (!isMobile() || event.pointerType !== 'touch') return;
    if (event.target.closest(excluded)) return;
    start = { x: event.clientX, y: event.clientY, t: performance.now() };
  }, { passive: true });

  document.addEventListener('pointerup', event => {
    if (!start || !isMobile() || event.pointerType !== 'touch') { start = null; return; }
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    const dt = performance.now() - start.t;
    start = null;

    if (dt > 900 || Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(dy) * 1.3) return;
    const delta = dx < 0 ? 1 : -1;

    // Internal workspaces are part of the swipe sequence. Once the user reaches
    // the first/last workspace, the next swipe continues to the adjacent
    // primary page. Pages without internal tabs move directly page-to-page.
    if (groups.length && moveTab(groups[0], delta)) return;
    movePrimary(delta);
  }, { passive: true });
})();
