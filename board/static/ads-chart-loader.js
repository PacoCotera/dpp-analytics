const CHART_ASSETS = {
  stylesheet: './chart-system.css',
  d3: './vendor/d3.v7.min.js',
  runtime: './chart-system.js',
};

let dependencyPromise;

export function adsChartAssetUrls(moduleUrl = import.meta.url) {
  const revision = new URL(moduleUrl).searchParams.get('v');
  return Object.fromEntries(
    Object.entries(CHART_ASSETS).map(([key, relativePath]) => {
      const url = new URL(relativePath, moduleUrl);
      if (revision) url.searchParams.set('v', revision);
      return [key, url.href];
    }),
  );
}

function loadStylesheet(documentRef, url) {
  return new Promise((resolve, reject) => {
    const link = documentRef.createElement('link');
    link.rel = 'stylesheet';
    link.href = url;
    link.dataset.adsChartDependency = 'stylesheet';
    link.addEventListener('load', resolve, { once: true });
    link.addEventListener('error', () => reject(new Error(`Could not load ${url}`)), { once: true });
    documentRef.head.append(link);
  });
}

function loadScript(documentRef, url, dependency) {
  return new Promise((resolve, reject) => {
    const script = documentRef.createElement('script');
    script.src = url;
    script.dataset.adsChartDependency = dependency;
    script.addEventListener('load', resolve, { once: true });
    script.addEventListener('error', () => reject(new Error(`Could not load ${url}`)), { once: true });
    documentRef.head.append(script);
  });
}

export function loadAdsChartDependencies(documentRef = document, windowRef = window) {
  if (dependencyPromise) return dependencyPromise;
  const urls = adsChartAssetUrls();
  dependencyPromise = Promise.all([
    loadStylesheet(documentRef, urls.stylesheet),
    loadScript(documentRef, urls.d3, 'd3').then(() => loadScript(documentRef, urls.runtime, 'runtime')),
  ]).then(() => {
    if (!windowRef.DPPCharts) throw new Error('Advertising chart runtime did not initialize');
    return urls;
  });
  return dependencyPromise;
}
