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

  if (document.body.classList.contains('today-shell')) {
    document.body.dataset.dayMode = new URLSearchParams(location.search).get('date') ? 'closed' : 'live';
    if (!document.getElementById('today-products-title-stable')) {
      const style = document.createElement('style');
      style.id = 'today-products-title-stable';
      style.textContent = `#productsTitle{font-size:0!important}#productsTitle:after{font-size:16px;font-weight:830;letter-spacing:.03em;content:'Products sold today'}body[data-day-mode='closed'] #productsTitle:after{content:'Products sold that day'}`;
      document.head.appendChild(style);
    }
    if (!document.querySelector('script[data-today-responsive-v2]')) {
      const script = document.createElement('script');
      script.src = '/assets/today-responsive-v2.js';
      script.dataset.todayResponsiveV2 = '1';
      document.body.appendChild(script);
    }
  }
})();
