(() => {
  'use strict';

  const PRIMARY = [
    { href: '/today', label: 'Today', className: 'today-link' },
    { href: '/', label: 'Home' },
    { href: '/sales', label: 'Sales' },
    { href: '/catalog', label: 'Products' },
    { href: '/inventory', label: 'Inventory' },
    { href: '/finance', label: 'Finance' },
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

  function buildNavigation(nav) {
    const current = normalizedPath();
    const moreActive = MORE.some(item => current === item.href);
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
      if (isCurrent(item.href)) {
        a.classList.add('active');
        a.setAttribute('aria-current', 'page');
      }
      primary.appendChild(a);
    }

    const more = document.createElement('details');
    more.className = `nav-more${moreActive ? ' active' : ''}`;
    more.setAttribute('data-no-swipe', '');
    const summary = document.createElement('summary');
    summary.innerHTML = `<span>More</span><span class="nav-more-chevron" aria-hidden="true">⌄</span>`;
    summary.setAttribute('aria-label', moreActive ? 'More navigation, current section inside' : 'More navigation');
    more.appendChild(summary);

    const menu = document.createElement('div');
    menu.className = 'nav-more-menu';
    menu.setAttribute('role', 'menu');
    for (const item of MORE) {
      const a = document.createElement('a');
      a.href = item.href;
      a.setAttribute('role', 'menuitem');
      if (isCurrent(item.href)) {
        a.classList.add('active');
        a.setAttribute('aria-current', 'page');
      }
      a.innerHTML = `<strong>${item.label}</strong><small>${item.hint}</small>`;
      menu.appendChild(a);
    }
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

  function revealActiveNavigation() {
    const nav = document.querySelector('.primary-nav');
    const set = nav?.querySelector('.nav-primary-set');
    const active = set?.querySelector('.active');
    if (!nav || !set || !active || window.innerWidth > 760) return;
    const left = active.offsetLeft - (set.clientWidth - active.offsetWidth) / 2;
    set.scrollTo({ left: Math.max(0, left), behavior: 'auto' });
  }

  function initializeShell() {
    const nav = document.querySelector('.primary-nav');
    if (nav) buildNavigation(nav);
    requestAnimationFrame(revealActiveNavigation);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initializeShell, { once: true });
  else initializeShell();
  window.addEventListener('resize', revealActiveNavigation, { passive: true });
})();
