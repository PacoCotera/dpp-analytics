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
    { href: '/ads', label: 'Ads', hint: 'Paid demand · setup pending' },
    { href: '/data-health', label: 'Data Health', hint: 'Source freshness and trust' },
  ];

  function normalizedPath() {
    const path = location.pathname.replace(/\/$/, '') || '/';
    if (path === '/product') return '/catalog';
    return path;
  }

  function isCurrent(href) {
    return normalizedPath() === href;
  }

  function appendMenuItem(menu, item, extraClass = '') {
    const a = document.createElement('a');
    a.href = item.href;
    a.setAttribute('role', 'menuitem');
    if (extraClass) a.classList.add(extraClass);
    if (isCurrent(item.href)) {
      a.classList.add('active');
      a.setAttribute('aria-current', 'page');
    }
    a.innerHTML = `<strong>${item.label}</strong><small>${item.hint}</small>`;
    menu.appendChild(a);
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
      const a = document.createElement('a');
      a.href = item.href;
      a.textContent = item.label;
      if (item.className) a.classList.add(item.className);
      if (item.mobileSecondary) a.classList.add('nav-mobile-secondary');
      if (isCurrent(item.href)) {
        a.classList.add('active');
        a.setAttribute('aria-current', 'page');
      }
      primary.appendChild(a);
    }

    const more = document.createElement('details');
    more.className = `nav-more${desktopMoreActive ? ' active' : ''}${mobileMoreActive ? ' mobile-active' : ''}`;
    more.setAttribute('data-no-swipe', '');
    const summary = document.createElement('summary');
    summary.innerHTML = `<span>More</span><span class="nav-more-chevron" aria-hidden="true">⌄</span>`;
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

  function initializeShell() {
    const nav = document.querySelector('.primary-nav');
    if (nav) buildNavigation(nav);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initializeShell, { once: true });
  else initializeShell();
})();
