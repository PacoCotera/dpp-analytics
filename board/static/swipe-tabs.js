(() => {
  const groups = [...document.querySelectorAll('.tabs, .view-tabs')]
    .map(tablist => ({
      tablist,
      tabs: [...tablist.querySelectorAll('button[data-view]')],
    }))
    .filter(x => x.tabs.length > 1);

  // Resolve primary links at gesture time. Shared navigation can be enhanced after
  // this script loads (for example when a new native workspace such as Ads appears).
  const primaryLinks = () => [...document.querySelectorAll('.primary-nav a:not(.disabled)')]
    .filter(link => link.href && new URL(link.href, location.href).origin === location.origin);

  const activeIndex = group => {
    const i = group.tabs.findIndex(tab => tab.classList.contains('active'));
    return i < 0 ? 0 : i;
  };

  const syncTabA11y = group => {
    const active = activeIndex(group);
    group.tabs.forEach((tab, i) => {
      const target = tab.dataset.view;
      tab.setAttribute('aria-selected', i === active ? 'true' : 'false');
      tab.setAttribute('tabindex', i === active ? '0' : '-1');
      if (target) {
        tab.setAttribute('aria-controls', target);
        const panel = document.getElementById(target);
        if (panel) {
          panel.setAttribute('role', 'tabpanel');
          panel.setAttribute('aria-labelledby', tab.id || `tab-${target}`);
          if (!tab.id) tab.id = `tab-${target}`;
        }
      }
    });
  };

  const moveTab = (group, delta) => {
    const from = activeIndex(group);
    const to = from + delta;
    if (to < 0 || to >= group.tabs.length) return false;
    group.tabs[to].click();
    syncTabA11y(group);
    group.tabs[to].focus({ preventScroll: true });
    group.tabs[to].scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    document.body.classList.add('tab-swiped');
    window.setTimeout(() => document.body.classList.remove('tab-swiped'), 180);
    return true;
  };

  const currentPrimaryIndex = links => {
    const explicit = links.findIndex(link => link.classList.contains('active'));
    if (explicit >= 0) return explicit;
    const here = location.pathname.replace(/\/$/, '') || '/';
    return links.findIndex(link => {
      const path = new URL(link.href, location.href).pathname.replace(/\/$/, '') || '/';
      return path === here;
    });
  };

  const movePrimary = delta => {
    const links = primaryLinks();
    const from = currentPrimaryIndex(links);
    if (from < 0) return false;
    const to = from + delta;
    if (to < 0 || to >= links.length) return false;
    const target = links[to];
    document.body.classList.add('page-swiped');
    window.setTimeout(() => { location.assign(target.href); }, 70);
    return true;
  };

  for (const group of groups) {
    group.tablist.setAttribute('role', group.tablist.getAttribute('role') || 'tablist');
    group.tabs.forEach(tab => {
      tab.setAttribute('role', tab.getAttribute('role') || 'tab');
      tab.addEventListener('click', () => window.setTimeout(() => syncTabA11y(group), 0));
      tab.addEventListener('keydown', event => {
        if (event.key === 'ArrowRight') { event.preventDefault(); moveTab(group, 1); }
        if (event.key === 'ArrowLeft') { event.preventDefault(); moveTab(group, -1); }
        if (event.key === 'Home') { event.preventDefault(); group.tabs[0].click(); syncTabA11y(group); group.tabs[0].focus(); }
        if (event.key === 'End') { event.preventDefault(); group.tabs.at(-1).click(); syncTabA11y(group); group.tabs.at(-1).focus(); }
      });
    });
    syncTabA11y(group);
  }

  let start = null;
  let suppressClickUntil = 0;
  const isMobile = () => matchMedia('(max-width: 760px)').matches;
  const explicitNoSwipe = '.primary-nav,.tabs,.view-tabs,.filters,.periods,.chart-tools,.table-wrap,.order-stream,.catalog-toolbar,input,textarea,select,button,svg,[data-no-swipe],[data-horizontal-scroll]';

  function hasHorizontalScrollRegion(target) {
    let el = target instanceof Element ? target : null;
    while (el && el !== document.body) {
      const style = getComputedStyle(el);
      const overflowX = style.overflowX;
      if ((overflowX === 'auto' || overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 3) return true;
      el = el.parentElement;
    }
    return false;
  }

  document.addEventListener('pointerdown', event => {
    if (!isMobile() || event.pointerType !== 'touch') return;
    if (event.target.closest(explicitNoSwipe) || hasHorizontalScrollRegion(event.target)) return;
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

    suppressClickUntil = performance.now() + 450;

    // Internal workspaces are part of the swipe sequence. Once the user reaches
    // the first/last workspace, the next swipe continues to the adjacent page.
    if (groups.length && moveTab(groups[0], delta)) return;
    movePrimary(delta);
  }, { passive: true });

  document.addEventListener('click', event => {
    if (performance.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopPropagation();
      suppressClickUntil = 0;
    }
  }, true);
})();
