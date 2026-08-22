import { byId, money, percent } from './ui-utils.js';

const sku = new URLSearchParams(window.location.search).get('sku') || '';

function pctRatio(value) {
  return value === null || value === undefined ? '—' : percent(100 * Number(value), { sign: false });
}

function number(value, digits = 2) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : '—';
}

function appendHealthContext(ads) {
  const read = byId('healthRead');
  if (!read) return;
  const spend = Number(ads.spend || 0);
  if (!spend) return;
  const sentence = ` Paid support is active at ${money(spend)} over 28D, with ${pctRatio(ads.tacos)} TACOS and ${number(ads.roas)}× attributed ROAS; this is context, not proof of causality.`;
  if (!read.textContent.includes('Paid support is active')) read.textContent += sentence;
}

function renderAds(ads = {}) {
  const state = byId('adsState');
  const note = byId('adsNote');
  const decision = byId('adsDecision');
  const read = byId('adsRead');
  if (!state || !note || !decision || !read) return;

  const spend = Number(ads.spend || 0);
  const observed = Number(ads.observed_ads_days || 0);
  const mature = Number(ads.mature_ads_days || 0);
  const trusted = Boolean(ads.trusted_for_operating_decisions);
  const attribution = ads.attribution_state || (observed ? (mature >= observed ? 'MATURE' : 'PROVISIONAL') : 'UNAVAILABLE');

  if (!ads.through_date || !observed) {
    state.textContent = 'No Ads data';
    note.textContent = 'Amazon Ads access/backfill pending';
    decision.textContent = 'Paid-support context pending';
    read.textContent = 'Seller demand remains readable without Ads. When Ads data arrives, this section will add spend, efficiency, coverage and attribution maturity without deriving “organic sales” by subtraction.';
    return;
  }

  state.textContent = trusted ? 'Decision-grade' : 'Review';
  state.className = trusted ? 'good' : 'warn';
  note.textContent = `${attribution.toLowerCase()} attribution · through ${ads.through_date}`;
  decision.textContent = `${money(spend)} spend · ${number(ads.roas)}× ROAS · ${pctRatio(ads.tacos)} TACOS`;

  const parts = [
    `${money(ads.attributed_sales || 0)} Amazon-attributed sales`,
    `${Number(ads.clicks || 0).toLocaleString()} clicks`,
    `${pctRatio(ads.ctr)} CTR`,
    `${ads.cpc == null ? '—' : money(ads.cpc)} CPC`,
    `${pctRatio(ads.acos)} ACOS`,
    `${observed} observed Ads day${observed === 1 ? '' : 's'}${mature < observed ? ` · ${mature} mature` : ''}`,
  ];
  read.textContent = `${parts.join(' · ')}. Attributed sales are not exact incremental sales, and total seller sales minus attributed sales is not exact organic sales.${trusted ? '' : ' Coverage or ingestion quality is not yet decision-grade.'}`;
  appendHealthContext(ads);
}

async function load() {
  if (!sku) return;
  try {
    const response = await fetch(`/api/product?sku=${encodeURIComponent(sku)}`, { cache: 'no-store' });
    if (!response.ok) return;
    const payload = await response.json();
    renderAds(payload.ads || {});
  } catch {
    // Base Product workspace owns the primary error state; Ads context is optional enrichment.
  }
}

window.setTimeout(load, 50);
