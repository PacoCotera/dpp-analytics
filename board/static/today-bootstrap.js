const params = new URLSearchParams(window.location.search);

if (params.get('wall') === '1') {
  document.documentElement.classList.add('wall-mode');
}
