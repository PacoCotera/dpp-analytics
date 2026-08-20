(() => {
  'use strict';

  function revealActiveNavigation() {
    const nav = document.querySelector('.primary-nav');
    const active = nav?.querySelector('.active');
    if (!nav || !active || window.innerWidth > 640) return;
    const left = active.offsetLeft - (nav.clientWidth - active.offsetWidth) / 2;
    nav.scrollTo({ left: Math.max(0, left), behavior: 'auto' });
  }

  function initializeShell() {
    const nav = document.querySelector('.primary-nav');
    if (nav) {
      nav.setAttribute('aria-label', 'Primary navigation');
      nav.querySelector('.active')?.setAttribute('aria-current', 'page');
    }
    requestAnimationFrame(revealActiveNavigation);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeShell, { once: true });
  } else {
    initializeShell();
  }
  window.addEventListener('resize', revealActiveNavigation, { passive: true });
})();
