(() => {
  const nav = document.querySelector('.primary-nav');
  if (!nav || nav.querySelector('a[href="/ads"]')) return;
  const link = document.createElement('a');
  link.href = '/ads';
  link.textContent = 'Ads';
  if (location.pathname === '/ads') link.classList.add('active');
  const finance = nav.querySelector('a[href="/finance"]');
  nav.insertBefore(link, finance || null);
})();
