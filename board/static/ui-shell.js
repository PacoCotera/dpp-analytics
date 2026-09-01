(() => {
  'use strict';

  const DOMAINS = [
    { href: '/', label: 'Today', key: 'today', className: 'today-link' },
    { href: '/business', label: 'Business', key: 'business' },
    { href: '/sales', label: 'Sales', key: 'sales' },
    { href: '/catalog', label: 'Products', key: 'products' },
    { href: '/inventory', label: 'Inventory', key: 'inventory', className: 'nav-mobile-secondary' },
    { href: '/finance', label: 'Finance', key: 'finance', className: 'nav-mobile-secondary' },
    { href: '/ads', label: 'Advertising', key: 'ads' },
    { href: '/trajectory', label: 'Trajectory', key: 'trajectory' },
    { href: '/data-health', label: 'Data Health', key: 'data-health' },
    { href: '/admin', label: 'Admin', key: 'admin' },
  ];
  const CONTEXT_KEY = 'dpp-page-context-v1';
  const MOBILE_QUERY = '(max-width: 900px)';
  const mobileMedia = window.matchMedia(MOBILE_QUERY);
  let drawerTrigger = null;

  function rawPath() {
    return location.pathname.replace(/\/$/, '') || '/';
  }

  function normalizedPath() {
    const path = rawPath();
    if (path === '/product') return '/catalog';
    if (path === '/today') return '/';
    if (path === '/home' || path === '/index.html') return '/business';
    return path;
  }

  function currentDomain() {
    return DOMAINS.find((item) => item.href === normalizedPath()) || DOMAINS[0];
  }

  function isCurrent(href) {
    return normalizedPath() === href;
  }

  function initializeBrandLink() {
    const brand = document.querySelector('.topbar .brand');
    if (!brand) return null;
    if (brand.matches('a')) {
      brand.href = '/';
      brand.setAttribute('aria-label', 'Open Today');
      return brand;
    }
    const link = document.createElement('a');
    link.href = '/';
    link.className = brand.className;
    link.innerHTML = brand.innerHTML;
    link.setAttribute('aria-label', 'Open Today');
    brand.replaceWith(link);
    return link;
  }

  function buildNavigation(nav) {
    nav.innerHTML = '';
    nav.id = 'app-navigation';
    nav.classList.add('app-navigation');
    nav.setAttribute('aria-label', 'Business domains');

    const primary = document.createElement('div');
    primary.className = 'nav-primary-set';

    const buildLink = (item) => {
      const anchor = document.createElement('a');
      anchor.href = item.href;
      anchor.className = 'domain-link';
      anchor.dataset.domain = item.key;
      if (item.className) anchor.classList.add(item.className);
      if (isCurrent(item.href)) {
        anchor.classList.add('active');
        anchor.setAttribute('aria-current', 'page');
      }

      const marker = document.createElement('span');
      marker.className = 'domain-link__marker';
      marker.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'domain-link__label';
      label.textContent = item.label;
      anchor.append(marker, label);
      return anchor;
    };

    for (const item of DOMAINS) primary.appendChild(buildLink(item));
    nav.appendChild(primary);
  }

  function createSidebar(nav) {
    const sidebar = document.createElement('aside');
    sidebar.id = 'app-sidebar';
    sidebar.className = 'app-sidebar';
    sidebar.setAttribute('aria-label', 'Application navigation');

    const sidebarHeader = document.createElement('div');
    sidebarHeader.className = 'app-sidebar__header';

    const brand = document.createElement('a');
    brand.className = 'brand app-sidebar__brand';
    brand.href = '/';
    brand.setAttribute('aria-label', 'Open Today');
    brand.innerHTML =
      '<span class="mark" aria-hidden="true">DP</span>' +
      '<span class="brand-copy">' +
      '<span class="brand-title">DIRTY PAWZ PRESS</span>' +
      '<span class="brand-sub">Business · Amazon Mexico</span>' +
      '</span>';

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'shell-drawer-close';
    closeButton.setAttribute('aria-label', 'Close navigation');
    closeButton.innerHTML = '<span aria-hidden="true">×</span>';
    closeButton.addEventListener('click', () => closeDrawer(true));

    sidebarHeader.append(brand, closeButton);
    sidebar.append(sidebarHeader, nav);

    const footer = document.createElement('div');
    footer.className = 'app-sidebar__footer';
    footer.innerHTML = '<strong>Amazon Mexico</strong><span>10 business domains</span>';
    sidebar.appendChild(footer);
    return sidebar;
  }

  function createBackdrop() {
    const backdrop = document.createElement('button');
    backdrop.type = 'button';
    backdrop.className = 'shell-backdrop';
    backdrop.tabIndex = -1;
    backdrop.setAttribute('aria-label', 'Close navigation');
    backdrop.setAttribute('aria-hidden', 'true');
    backdrop.addEventListener('click', () => closeDrawer(true));
    return backdrop;
  }

  function createDiagnosticsFooter(app) {
    if (app.querySelector(':scope > footer.footer')) return;

    const buildRevision = document.querySelector('meta[name="dpp-build-revision"]')?.content || 'dev';
    const assetRevision = document.querySelector('meta[name="dpp-asset-revision"]')?.content || 'dev';
    const footer = document.createElement('footer');
    footer.className = 'footer';
    footer.setAttribute('aria-label', 'Build diagnostics');

    const details = document.createElement('details');
    details.className = 'footer-diagnostics';
    const summary = document.createElement('summary');
    summary.textContent = 'Build info';
    const values = document.createElement('div');
    values.className = 'footer-diagnostics__values';
    const build = document.createElement('span');
    build.className = 'footer-build';
    build.textContent = `main ${buildRevision}`;
    const assets = document.createElement('span');
    assets.className = 'footer-assets';
    assets.textContent = `assets ${assetRevision}`;
    values.append(build, assets);
    details.append(summary, values);
    footer.appendChild(details);
    app.appendChild(footer);
  }

  function openDrawer(trigger) {
    const sidebar = document.getElementById('app-sidebar');
    const menuButton = document.querySelector('.shell-menu-button');
    if (!sidebar || !mobileMedia.matches) return;
    drawerTrigger = trigger || menuButton;
    document.body.classList.add('shell-drawer-open');
    sidebar.removeAttribute('inert');
    sidebar.setAttribute('aria-hidden', 'false');
    menuButton?.setAttribute('aria-expanded', 'true');
    const closeButton = sidebar.querySelector('.shell-drawer-close');
    closeButton?.focus({ preventScroll: true });
    window.requestAnimationFrame(() => {
      if (closeButton && document.activeElement !== closeButton) closeButton.focus({ preventScroll: true });
    });
  }

  function closeDrawer(returnFocus) {
    const sidebar = document.getElementById('app-sidebar');
    const menuButton = document.querySelector('.shell-menu-button');
    document.body.classList.remove('shell-drawer-open');
    menuButton?.setAttribute('aria-expanded', 'false');
    if (mobileMedia.matches && sidebar) {
      sidebar.setAttribute('inert', '');
      sidebar.setAttribute('aria-hidden', 'true');
    }
    if (returnFocus) (drawerTrigger || menuButton)?.focus();
    drawerTrigger = null;
  }

  function syncDrawerMode() {
    const sidebar = document.getElementById('app-sidebar');
    if (!sidebar) return;
    if (mobileMedia.matches) {
      closeDrawer(false);
      return;
    }
    document.body.classList.remove('shell-drawer-open');
    sidebar.removeAttribute('inert');
    sidebar.setAttribute('aria-hidden', 'false');
    document.querySelector('.shell-menu-button')?.setAttribute('aria-expanded', 'false');
  }

  function focusableElements(container) {
    return [
      ...container.querySelectorAll(
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
      ),
    ].filter((element) => !element.hidden && element.getClientRects().length > 0);
  }

  function trapDrawerFocus(event) {
    if (event.key !== 'Tab' || !mobileMedia.matches) return;
    if (!document.body.classList.contains('shell-drawer-open')) return;
    const sidebar = document.getElementById('app-sidebar');
    if (!sidebar) return;
    const focusable = focusableElements(sidebar);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    } else if (!sidebar.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
    }
  }

  function presentationRuntime() {
    return window.dppPresentation || null;
  }

  function createAppearancePanel(trigger) {
    const runtime = presentationRuntime();
    const panel = document.createElement('div');
    panel.id = 'appearance-panel';
    panel.className = 'appearance-panel';
    panel.hidden = true;
    panel.setAttribute('aria-labelledby', 'appearance-title');

    const panelHeader = document.createElement('div');
    panelHeader.className = 'appearance-panel__header';
    const title = document.createElement('h2');
    title.id = 'appearance-title';
    title.textContent = 'Appearance';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'appearance-panel__close';
    close.setAttribute('aria-label', 'Close Appearance');
    close.innerHTML = '<span aria-hidden="true">×</span>';
    close.addEventListener('click', () => closeAppearance(true));
    panelHeader.append(title, close);

    const fieldset = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = 'Choose a visual profile';
    fieldset.appendChild(legend);

    const list = document.createElement('div');
    list.className = 'appearance-options';
    const profiles = runtime?.listProfiles() || [];
    const selectedId = runtime?.getProfileId() || 'warm-studio';

    for (const profile of profiles) {
      const option = document.createElement('label');
      option.className = 'appearance-option';
      option.htmlFor = 'appearance-' + profile.id;

      const radio = document.createElement('input');
      radio.id = 'appearance-' + profile.id;
      radio.type = 'radio';
      radio.name = 'dpp-appearance';
      radio.value = profile.id;
      radio.checked = profile.id === selectedId;
      radio.addEventListener('change', () => {
        if (radio.checked) runtime?.setProfile(profile.id);
      });

      const swatch = document.createElement('span');
      swatch.className = 'appearance-option__swatch';
      swatch.dataset.profileSwatch = profile.id;
      swatch.style.setProperty('--appearance-swatch', profile.themeColor);
      swatch.setAttribute('aria-hidden', 'true');

      const copy = document.createElement('span');
      copy.className = 'appearance-option__copy';
      const name = document.createElement('strong');
      name.textContent = profile.displayName;
      const description = document.createElement('small');
      description.textContent = profile.description;
      copy.append(name, description);
      option.append(radio, swatch, copy);
      list.appendChild(option);
    }

    fieldset.appendChild(list);
    panel.append(panelHeader, fieldset);
    document.body.appendChild(panel);

    trigger.addEventListener('click', () => {
      if (panel.hidden) openAppearance();
      else closeAppearance(true);
    });

    window.addEventListener(runtime?.eventName || 'dpp:presentationchange', (event) => {
      const profileId = event.detail?.profileId || runtime?.getProfileId();
      syncAppearance(profileId);
    });

    return panel;
  }

  function syncAppearance(profileId) {
    const runtime = presentationRuntime();
    const activeId = profileId || runtime?.getProfileId() || 'warm-studio';
    const active = runtime?.getProfile?.();
    document.querySelectorAll('input[name="dpp-appearance"]').forEach((input) => {
      input.checked = input.value === activeId;
    });
    const trigger = document.querySelector('.appearance-trigger');
    if (trigger) {
      const label = active?.displayName || activeId;
      trigger.setAttribute('aria-label', 'Appearance: ' + label);
      const current = trigger.querySelector('.appearance-button__current');
      if (current) current.textContent = label;
    }
  }

  function openAppearance() {
    const panel = document.getElementById('appearance-panel');
    const trigger = document.querySelector('.appearance-trigger');
    if (!panel || !trigger) return;
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    const checked = panel.querySelector('input:checked');
    window.requestAnimationFrame(() => (checked || panel.querySelector('input'))?.focus());
  }

  function closeAppearance(returnFocus) {
    const panel = document.getElementById('appearance-panel');
    const trigger = document.querySelector('.appearance-trigger');
    if (!panel || panel.hidden) return;
    panel.hidden = true;
    trigger?.setAttribute('aria-expanded', 'false');
    if (returnFocus) trigger?.focus();
  }

  function createGlobalHeader(topbar) {
    topbar.classList.add('shell-global-header');
    const brand = initializeBrandLink();

    const menuButton = document.createElement('button');
    menuButton.type = 'button';
    menuButton.className = 'shell-menu-button';
    menuButton.setAttribute('aria-label', 'Open navigation');
    menuButton.setAttribute('aria-controls', 'app-sidebar');
    menuButton.setAttribute('aria-expanded', 'false');
    menuButton.innerHTML =
      '<span class="shell-menu-button__icon" aria-hidden="true"><span></span><span></span><span></span></span>';
    menuButton.addEventListener('click', () => openDrawer(menuButton));

    const actions = document.createElement('div');
    actions.className = 'shell-header-actions';
    const meta = topbar.querySelector('.top-meta');
    if (meta) actions.appendChild(meta);

    const appearance = document.createElement('button');
    appearance.type = 'button';
    appearance.className = 'appearance-trigger';
    appearance.setAttribute('aria-controls', 'appearance-panel');
    appearance.setAttribute('aria-expanded', 'false');
    appearance.innerHTML =
      '<span class="appearance-button__icon" aria-hidden="true"></span>' +
      '<span class="appearance-button__label">Appearance</span>' +
      '<span class="appearance-button__current"></span>';
    actions.appendChild(appearance);

    const context = document.createElement('div');
    context.className = 'shell-header-context';
    context.innerHTML =
      '<span class="shell-header-context__eyebrow">DPP Analytics</span>' +
      '<strong class="shell-header-context__title">' +
      currentDomain().label +
      '</strong>';

    topbar.prepend(menuButton);
    if (brand) brand.classList.add('shell-mobile-brand');
    topbar.append(context, actions);
    createAppearancePanel(appearance);
    syncAppearance();
  }

  function initializeApplicationShell() {
    const app = document.querySelector('.app');
    const topbar = app?.querySelector('.topbar');
    const nav = app?.querySelector('.primary-nav');
    if (!app || !topbar || !nav) return;

    document.title = `Dirty Pawz Press · ${currentDomain().label}`;
    buildNavigation(nav);
    const sidebar = createSidebar(nav);
    const backdrop = createBackdrop();
    const skipLink = document.querySelector('.skip-link');
    if (skipLink) skipLink.after(backdrop, sidebar);
    else document.body.prepend(backdrop, sidebar);
    createGlobalHeader(topbar);
    createDiagnosticsFooter(app);
    syncDrawerMode();

    if (typeof mobileMedia.addEventListener === 'function')
      mobileMedia.addEventListener('change', syncDrawerMode);
    else mobileMedia.addListener(syncDrawerMode);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        const panel = document.getElementById('appearance-panel');
        if (panel && !panel.hidden) {
          closeAppearance(true);
          return;
        }
        if (document.body.classList.contains('shell-drawer-open')) closeDrawer(true);
      }
      trapDrawerFocus(event);
    });

    document.addEventListener('pointerdown', (event) => {
      const panel = document.getElementById('appearance-panel');
      const trigger = document.querySelector('.appearance-trigger');
      if (panel?.hidden || panel?.contains(event.target) || trigger?.contains(event.target)) return;
      closeAppearance(false);
    });
  }

  function workspaceGroups() {
    return [...document.querySelectorAll('.tabs, .subnav')]
      .map((tablist) => ({
        tablist,
        tabs: [...tablist.querySelectorAll('button[data-view], button[data-ads-view]')],
      }))
      .filter((group) => group.tabs.length > 1);
  }

  function primaryLinks() {
    return [...document.querySelectorAll('.primary-nav a:not(.disabled)')].filter(
      (link) => link.href && new URL(link.href, location.href).origin === location.origin,
    );
  }

  function activeIndex(group) {
    const index = group.tabs.findIndex((tab) => tab.classList.contains('active'));
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
      if (!tab.id) tab.id = 'tab-' + target;
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
    const explicit = links.findIndex((link) => link.classList.contains('active'));
    if (explicit >= 0) return explicit;
    const here = normalizedPath();
    return links.findIndex((link) => new URL(link.href, location.href).pathname.replace(/\/$/, '') === here);
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
      if (
        (style.overflowX === 'auto' || style.overflowX === 'scroll') &&
        element.scrollWidth > element.clientWidth + 3
      )
        return true;
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
      tabs: groups.map((group) => targetId(group.tabs[activeIndex(group)])),
      at: Date.now(),
    };
    try {
      sessionStorage.setItem(CONTEXT_KEY, JSON.stringify(context));
    } catch {
      return;
    }
  }

  function restorePageContext() {
    let context = null;
    try {
      context = JSON.parse(sessionStorage.getItem(CONTEXT_KEY) || 'null');
    } catch {
      context = null;
    }
    if (!context || context.path !== rawPath() || Date.now() - Number(context.at || 0) > 6 * 60 * 60 * 1000)
      return;
    const contextUrl = new URL(context.href, location.href);
    if (contextUrl.search !== location.search) return;
    const groups = workspaceGroups();
    (context.tabs || []).forEach((target, index) => {
      const group = groups[index];
      const tab = group?.tabs.find((item) => targetId(item) === target);
      if (tab && !tab.classList.contains('active')) tab.click();
    });
    window.requestAnimationFrame(() =>
      window.scrollTo({ top: Number(context.scrollY || 0), behavior: 'instant' }),
    );
  }

  function initializeContextPersistence() {
    let timer = null;
    const queueSave = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(savePageContext, 120);
    };
    window.addEventListener('scroll', queueSave, { passive: true });
    window.addEventListener('pagehide', savePageContext);
    document.addEventListener(
      'click',
      (event) => {
        if (event.target.closest('button[data-view],button[data-ads-view],a')) queueSave();
      },
      true,
    );
    restorePageContext();
  }

  function initializeSwipeNavigation() {
    const groups = workspaceGroups();
    for (const group of groups) {
      group.tablist.setAttribute('role', group.tablist.getAttribute('role') || 'tablist');
      group.tabs.forEach((tab) => {
        tab.setAttribute('role', tab.getAttribute('role') || 'tab');
        tab.addEventListener('click', () => window.setTimeout(() => syncTabA11y(group), 0));
        tab.addEventListener('keydown', (event) => {
          if (event.key === 'ArrowRight') {
            event.preventDefault();
            moveTab(group, 1);
          } else if (event.key === 'ArrowLeft') {
            event.preventDefault();
            moveTab(group, -1);
          } else if (event.key === 'Home') {
            event.preventDefault();
            group.tabs[0].click();
            syncTabA11y(group);
            group.tabs[0].focus();
          } else if (event.key === 'End') {
            event.preventDefault();
            group.tabs.at(-1).click();
            syncTabA11y(group);
            group.tabs.at(-1).focus();
          }
        });
      });
      syncTabA11y(group);
    }

    let start = null;
    let suppressClickUntil = 0;
    const explicitNoSwipe =
      '.app-sidebar,.shell-global-header,.primary-nav,.appearance-panel,.tabs,.subnav,.filters,.periods,.chart-tools,.data-table-scroll,.order-stream,.chart,.rhythm-host,.trajectory-chart,.sales-chart,.chart-wrap,.chart-host,input,textarea,select,button,canvas,svg,[role="slider"],[data-no-swipe],[data-horizontal-scroll]';

    document.addEventListener(
      'pointerdown',
      (event) => {
        if (!mobileMedia.matches || event.pointerType !== 'touch') return;
        if (document.body.classList.contains('shell-drawer-open')) return;
        if (event.target.closest(explicitNoSwipe) || hasHorizontalScrollRegion(event.target)) return;
        start = { x: event.clientX, y: event.clientY, t: performance.now() };
      },
      { passive: true },
    );

    document.addEventListener(
      'pointerup',
      (event) => {
        if (!start || !mobileMedia.matches || event.pointerType !== 'touch') {
          start = null;
          return;
        }
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
      },
      { passive: true },
    );

    document.addEventListener(
      'click',
      (event) => {
        if (performance.now() >= suppressClickUntil) return;
        event.preventDefault();
        event.stopPropagation();
        suppressClickUntil = 0;
      },
      true,
    );
  }

  function initializeShell() {
    initializeApplicationShell();
    initializeSwipeNavigation();
    initializeContextPersistence();
  }

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', initializeShell, { once: true });
  else initializeShell();
})();
