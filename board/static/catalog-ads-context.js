import { fetchJson, money, percent } from './ui-utils.js';

function pctRatio(value) {
  return value === null || value === undefined ? '—' : percent(100 * Number(value), { sign: false });
}

function number(value, digits = 2) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : '—';
}

function appendOnce(node, text, marker) {
  if (!node || !text || node.dataset[marker] === '1') return;
  node.textContent += text;
  node.dataset[marker] = '1';
}

function familyPaidRead(family) {
  const spend = Number(family.ad_spend_t28 || 0);
  if (!spend) return '';
  const maturity = String(family.ad_attribution_state || 'UNAVAILABLE').toLowerCase();
  return ` · Paid ${money(spend)} · ${pctRatio(family.ad_tacos_t28)} TACOS · ${number(family.ad_roas_t28)}× ROAS · ${maturity}`;
}

function productPaidRead(product) {
  const spend = Number(product.ad_spend_t28 || 0);
  if (!spend) return '';
  const maturity = String(product.ad_attribution_state || 'UNAVAILABLE').toLowerCase();
  return ` · Paid ${money(spend)} · ${pctRatio(product.ad_tacos_t28)} TACOS · ${number(product.ad_roas_t28)}× ROAS · ${maturity}`;
}

function decorate(payload) {
  const summary = payload.summary || {};
  const spend = Number(summary.ad_spend_t28 || 0);
  const basis = document.getElementById('portfolioBasis');
  const freshness = document.getElementById('freshness');

  if (spend > 0) {
    appendOnce(
      basis,
      ` · Paid support ${money(spend)} · ${pctRatio(summary.ad_tacos_t28)} TACOS · ${number(summary.ad_roas_t28)}× attributed ROAS`,
      'adsSummary',
    );
    appendOnce(
      freshness,
      ` · Ads through ${summary.ads_through_date || 'latest available day'}`,
      'adsFreshness',
    );
  } else {
    appendOnce(basis, ' · Paid support awaiting Amazon Ads data', 'adsSummary');
  }

  const families = new Map(
    (payload.families || []).map((family) => [String(family.family_asin || ''), family]),
  );
  document.querySelectorAll('.family[data-family]').forEach((row) => {
    const family = families.get(String(row.dataset.family || ''));
    if (!family) return;
    appendOnce(row.querySelector('.family-meta'), familyPaidRead(family), 'adsRead');
  });

  const products = new Map((payload.products || []).map((product) => [String(product.sku || ''), product]));
  document
    .querySelectorAll('a.child[href^="/product?sku="], a.analysis-link[href^="/product?sku="]')
    .forEach((row) => {
      const url = new URL(row.getAttribute('href'), window.location.origin);
      const product = products.get(url.searchParams.get('sku') || '');
      if (!product) return;
      const meta = row.querySelector('.child-meta') || row.querySelector('.analysis-identity span');
      appendOnce(meta, productPaidRead(product), 'adsRead');
    });
}

function attach(payload) {
  const portfolio = document.getElementById('portfolio');
  const ready = document.getElementById('portfolioBasis')?.textContent?.includes('28D through');
  if (!ready) {
    window.setTimeout(() => attach(payload), 80);
    return;
  }
  decorate(payload);
  if (portfolio && window.MutationObserver) {
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      window.requestAnimationFrame(() => {
        queued = false;
        decorate(payload);
      });
    }).observe(portfolio, { childList: true, subtree: true });
  }
}

async function load() {
  try {
    attach(await fetchJson('/api/catalog'));
  } catch {
    // Catalog owns the primary loading/error state; Ads is optional enrichment.
  }
}

load();
