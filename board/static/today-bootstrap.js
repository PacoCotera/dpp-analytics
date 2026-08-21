const params = new URLSearchParams(window.location.search);

if (params.get('wall') === '1') {
  document.documentElement.classList.add('wall-mode');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#12110f');
}
