(() => {
  'use strict';

  const PRIMARY = [
    { href: '/today', label: 'Today', className: 'today-link' },
    { href: '/', label: 'Home' },
    { href: '/sales', label: 'Sales' },
    { href: '/catalog', label: 'Products' },
    { href: '/inventory', label: 'Inventory', mobileSecondary: true },
    { href: '/finance', label: 'Finance', mobileSecondary: true },
  ];
  const MOBILE_MORE = [
    { href: '/inventory', label: 'Inventory', hint: 'Stock, cover and replenishment' },
    { href: '/finance', label: 'Finance', hint: 'Accounting periods and contribution' },
  ];
  const MORE = [
    { href: '/trajectory', label: 'Trajectory', hint: 'Longer-horizon momentum' },
    { href: '/ads', label: 'Ads', hint: 'Paid demand and Amazon attribution' },
    { href: '/data-health', label: 'Data Health', hint: 'Source freshness and trust' },
  ];
  const WORKSPACES = {
    '/': { title: 'Home', copy: 'Business state, operating decisions and the drivers behind them.' },
    '/sales': { title: 'Sales', copy: 'Revenue, momentum and product performance.' },
    '/catalog': { title: 'Products', copy: 'Commercial portfolio, demand, conversion, availability and economics.' },
    '/finance': { title: 'Finance', copy: 'Accounting periods, contribution and immutable closed history.' },
    '/trajectory': { title: 'Trajectory', copy: 'Longer-horizon momentum and structural business strength.' },
    '/ads': { title: 'Ads', copy: 'Paid demand, efficiency and Amazon attribution.' },
    '/data-health': { title: 'Data Health', copy: 'Source freshness, coverage and trust.' },
  };
  const CONTEXT_KEY = 'dpp-page-context-v1';

  function rawPath() {
    return location.pathname.replace(/\/$/, '') || '/';
  }

  function normalizedPath() {
    const path = rawPath();
    if (path === '/product') return '/catalog';
    return path;
  }

  function isCurrent(href) {
    return normalizedPath() === href;
  }

  function appendMenuItem(menu, item, extraClass = '') {
    const anchor = document.createElement('a');
    anchor.href = item.href;
    anchor.setAttribute('role', 'menuitem');
    if (extraClass) anchor.classList.add(extraClass);
    if (isCurrent(item.href)) {
      anchor.classList.add('active');
      anchor.setAttribute('aria-current', 'page');
    }
    anchor.innerHTML = `<strong>${item.label}</strong><small>${item.hint}</small>`;
    menu.appendChild(anchor);
  }

  function buildNavigation(nav) {
    const current = normalizedPath();
    const desktopMoreActive = MORE.some(item => current === item.href);
    const mobileMoreActive = [...MOBILE_MORE, ...MORE].some(item => current === item.href);
    nav.innerHTML = '';
    nav.classList.add('app-navigation');
    nav.setAttribute('aria-label', 'Primary navigation');

    const primary = document.createElement('div');
    primary.className = 'nav-primary-set';
    for (const item of PRIMARY) {
      const anchor = document.createElement('a');
      anchor.href = item.href;
      anchor.textContent = item.label;
      if (item.className) anchor.classList.add(item.className);
      if (item.mobileSecondary) anchor.classList.add('nav-mobile-secondary');
      if (isCurrent(item.href)) {
        anchor.classList.add('active');
        anchor.setAttribute('aria-current', 'page');
      }
      primary.appendChild(anchor);
    }

    const more = document.createElement('details');
    more.className = `nav-more${desktopMoreActive ? ' active' : ''}${mobileMoreActive ? ' mobile-active' : ''}`;
    more.setAttribute('data-no-swipe', '');
    const summary = document.createElement('summary');
    summary.innerHTML = '<span>More</span><span class="nav-more-chevron" aria-hidden="true">⌄</span>';
    summary.setAttribute('aria-label', mobileMoreActive ? 'More navigation, current section inside' : 'More navigation');
    more.appendChild(summary);

    const menu = document.createElement('div');
    menu.className = 'nav-more-menu';
    menu.setAttribute('role', 'menu');
    for (const item of MOBILE_MORE) appendMenuItem(menu, item, 'nav-mobile-only');
    const divider = document.createElement('div');
    divider.className = 'nav-more-divider nav-mobile-only';
    menu.appendChild(divider);
    for (const item of MORE) appendMenuItem(menu, item);
    more.appendChild(menu);
    nav.append(primary, more);

    document.addEventListener('pointerdown', event => {
      if (more.open && !more.contains(event.target)) more.open = false;
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && more.open) {
        more.open = false;
        summary.focus();
      }
    });
  }

  function buildWorkspaceIdentity(nav) {
    const path = rawPath();
    if (path === '/today' || path === '/inventory' || path === '/product') return;
    if (document.querySelector('.page-header')) return;
    const spec = WORKSPACES[path];
    if (!spec || document.querySelector('.workspace-identity')) return;

    const identity = document.createElement('header');
    identity.className = `workspace-identity workspace-${path === '/' ? 'home' : path.slice(1).replace(/[^a-z0-9-]/gi, '-')}`;
    identity.innerHTML = `<div><h1>${spec.title}</h1><p>${spec.copy}</p></div>`;
    nav.insertAdjacentElement('afterend', identity);
    document.body.classList.add('has-workspace-identity');

    const legacy = document.querySelector('.page-head');
    if (legacy) legacy.classList.add('workspace-legacy-head');
    if (path === '/finance') {
      const financeHead = document.querySelector('.finance-head');
      financeHead?.firstElementChild?.classList.add('workspace-legacy-head');
      financeHead?.classList.add('workspace-finance-period');
    }
  }

  function workspaceGroups() {
    return [...document.querySelectorAll('.tabs, .view-tabs, .subnav')]
      .map(tablist => ({ tablist, tabs: [...tablist.querySelectorAll('button[data-view], button[data-ads-view]')] }))
      .filter(group => group.tabs.length > 1);
  }

  function primaryLinks() {
    return [...document.querySelectorAll('.primary-nav a:not(.disabled)')]
      .filter(link => link.href && new URL(link.href, location.href).origin === location.origin);
  }

  function activeIndex(group) {
    const index = group.tabs.findIndex(tab => tab.classList.contains('active'));
    return index < 0 ? 0 : index;
  }

  function targetId(tab) {
    return tab.dataset.view || tab.dataset.adsView || '';
  }

  function syncTabA11y(group) {
    const active = activeIndex(group);
    group.tabs.forEach((tab, index) => {
      const target = targetId(tab);
      tab.setAttribute('aria-selected', index === active ? 'true' : 'false');
      tab.setAttribute('tabindex', index === active ? '0' : '-1');
      if (!target) return;
      tab.setAttribute('aria-controls', target);
      const panel = document.getElementById(target);
      if (!panel) return;
      if (!tab.id) tab.id = `tab-${target}`;
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tab.id);
    });
  }

  function moveTab(group, delta) {
    const next = activeIndex(group) + delta;
    if (next < 0 || next >= group.tabs.length) return false;
    group.tabs[next].click();
    syncTabA11y(group);
    group.tabs[next].focus({ preventScroll: true });
    group.tabs[next].scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    document.body.classList.add('tab-swiped');
    window.setTimeout(() => document.body.classList.remove('tab-swiped'), 180);
    return true;
  }

  function currentPrimaryIndex(links) {
    const explicit = links.findIndex(link => link.classList.contains('active'));
    if (explicit >= 0) return explicit;
    const here = location.pathname.replace(/\/$/, '') || '/';
    return links.findIndex(link => new URL(link.href, location.href).pathname.replace(/\/$/, '') === here);
  }

  function movePrimary(delta) {
    const links = primaryLinks();
    const next = currentPrimaryIndex(links) + delta;
    if (next < 0 || next >= links.length) return false;
    document.body.classList.add('page-swiped');
    window.setTimeout(() => location.assign(links[next].href), 70);
    return true;
  }

  function hasHorizontalScrollRegion(target) {
    let element = target instanceof Element ? target : null;
    while (element && element !== document.body) {
      const style = getComputedStyle(element);
      if ((style.overflowX === 'auto' || style.overflowX === 'scroll') && element.scrollWidth > element.clientWidth + 3) return true;
      element = element.parentElement;
    }
    return false;
  }

  function savePageContext() {
    if (document.visibilityState === 'hidden') return;
    const groups = workspaceGroups();
    const context = {
      href: location.href,
      path: rawPath(),
      scrollY: Math.round(window.scrollY),
      tabs: groups.map(group => targetId(group.tabs[activeIndex(group)])),
      at: Date.now(),
    };
    try { sessionStorage.setItem(CONTEXT_KEY, JSON.stringify(context)); } catch (_) {}
  }

  function restorePageContext() {
    let context = null;
    try { context = JSON.parse(sessionStorage.getItem(CONTEXT_KEY) || 'null'); } catch (_) {}
    if (!context || context.path !== rawPath() || Date.now() - Number(context.at || 0) > 6 * 60 * 60 * 1000) return;
    const groups = workspaceGroups();
    (context.tabs || []).forEach((target, index) => {
      const group = groups[index];
      const tab = group?.tabs.find(item => targetId(item) === target);
      if (tab && !tab.classList.contains('active')) tab.click();
    });
    window.requestAnimationFrame(() => window.scrollTo({ top: Number(context.scrollY || 0), behavior: 'instant' }));
  }

  function initializeContextPersistence() {
    let timer = null;
    const queueSave = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(savePageContext, 120);
    };
    window.addEventListener('scroll', queueSave, { passive: true });
    window.addEventListener('pagehide', savePageContext);
    document.addEventListener('click', event => {
      if (event.target.closest('button[data-view],button[data-ads-view],a')) queueSave();
    }, true);
    restorePageContext();
  }

  function initializeSwipeNavigation() {
    const groups = workspaceGroups();
    for (const group of groups) {
      group.tablist.setAttribute('role', group.tablist.getAttribute('role') || 'tablist');
      group.tabs.forEach(tab => {
        tab.setAttribute('role', tab.getAttribute('role') || 'tab');
        tab.addEventListener('click', () => window.setTimeout(() => syncTabA11y(group), 0));
        tab.addEventListener('keydown', event => {
          if (event.key === 'ArrowRight') { event.preventDefault(); moveTab(group, 1); }
          else if (event.key === 'ArrowLeft') { event.preventDefault(); moveTab(group, -1); }
          else if (event.key === 'Home') { event.preventDefault(); group.tabs[0].click(); syncTabA11y(group); group.tabs[0].focus(); }
          else if (event.key === 'End') { event.preventDefault(); group.tabs.at(-1).click(); syncTabA11y(group); group.tabs.at(-1).focus(); }
        });
      });
      syncTabA11y(group);
    }

    let start = null;
    let suppressClickUntil = 0;
    const isMobile = () => matchMedia('(max-width: 760px)').matches;
    const explicitNoSwipe = '.primary-nav,.tabs,.view-tabs,.subnav,.filters,.periods,.chart-tools,.table-wrap,.order-stream,.chart,.rhythm-host,.trajectory-chart,.sales-chart,.chart-wrap,.chart-host,input,textarea,select,button,canvas,svg,[role="slider"],[data-no-swipe],[data-horizontal-scroll]';

    document.addEventListener('pointerdown', event => {
      if (!isMobile() || event.pointerType !== 'touch') return;
      if (event.target.closest(explicitNoSwipe) || hasHorizontalScrollRegion(event.target)) return;
      start = { x: event.clientX, y: event.clientY, t: performance.now() };
    }, { passive: true });

    document.addEventListener('pointerup', event => {
      if (!start || !isMobile() || event.pointerType !== 'touch') { start = null; return; }
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      const elapsed = performance.now() - start.t;
      start = null;
      const distance = Math.abs(dx);
      const viewportShare = distance / Math.max(1, window.innerWidth);
      const horizontalIntent = distance >= 110 && viewportShare >= 0.28 && distance >= Math.abs(dy) * 2.1;
      if (elapsed > 700 || !horizontalIntent) return;

      const delta = dx < 0 ? 1 : -1;
      suppressClickUntil = performance.now() + 450;
      if (groups.length && moveTab(groups[0], delta)) return;
      movePrimary(delta);
    }, { passive: true });

    document.addEventListener('click', event => {
      if (performance.now() >= suppressClickUntil) return;
      event.preventDefault();
      event.stopPropagation();
      suppressClickUntil = 0;
    }, true);
  }

  function initializeShell() {
    const nav = document.querySelector('.primary-nav');
    if (!nav) return;
    buildNavigation(nav);
    buildWorkspaceIdentity(nav);
    initializeSwipeNavigation();
    initializeContextPersistence();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initializeShell, { once: true });
  else initializeShell();
})();
