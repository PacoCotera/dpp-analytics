(() => {
  const nav = document.querySelector('.primary-nav');
  if (nav && !nav.querySelector('a[href="/ads"]')) {
    const link = document.createElement('a');
    link.href = '/ads';
    link.textContent = 'Ads';
    if (location.pathname === '/ads') link.classList.add('active');
    const finance = nav.querySelector('a[href="/finance"]');
    nav.insertBefore(link, finance || null);
  }

  if (document.body.classList.contains('today-shell') && !document.querySelector('script[data-today-responsive-v2]')) {
    const script = document.createElement('script');
    script.src = '/assets/today-responsive-v2.js';
    script.dataset.todayResponsiveV2 = '1';
    document.body.appendChild(script);
  }
})();
