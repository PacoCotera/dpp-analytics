import fs from 'node:fs/promises';
import path from 'node:path';

const baseUrl = (process.argv[2] || 'http://127.0.0.1:8088').replace(/\/$/, '');
const outDir = process.argv[3] || '/out';
await fs.mkdir(outDir, { recursive: true });

async function getJson(route) {
  const response = await fetch(`${baseUrl}${route}`, { cache: 'no-store' });
  const body = await response.json();
  if (!response.ok)
    throw new Error(`${route} returned ${response.status}: ${body?.error || 'unknown error'}`);
  return { response, body };
}

try {
  const catalog = await getJson('/api/catalog?refresh=1');
  const health = await getJson('/api/data-health?refresh=1');
  const lifecycle = catalog.body.catalog_onboarding;
  if (!lifecycle?.summary || !Array.isArray(lifecycle.items)) {
    throw new Error('Catalog payload is missing catalog_onboarding lifecycle state');
  }
  if (Number(lifecycle.summary.grace_hours) !== 48) {
    throw new Error(`Expected 48h catalog onboarding grace, got ${lifecycle.summary.grace_hours}`);
  }
  if ((catalog.body.summary?.taxonomy_unmapped_skus || []).length) {
    throw new Error('Mutable taxonomy completeness leaked back into the legacy deployment-blocking field');
  }

  const missingLifecycle = catalog.body.summary?.catalog_lifecycle_missing_skus || [];
  if (missingLifecycle.length) {
    throw new Error(`Catalog SKUs missing lifecycle evidence: ${missingLifecycle.join(', ')}`);
  }

  const bySku = new Map(lifecycle.items.map((item) => [String(item.sku || ''), item]));
  const actionableTaxonomy = catalog.body.summary?.taxonomy_attention_skus || [];
  const onboardingTaxonomy = catalog.body.summary?.taxonomy_onboarding_skus || [];
  const inactiveTaxonomy = catalog.body.summary?.taxonomy_inactive_skus || [];
  const sourceAttention = catalog.body.summary?.catalog_source_attention_skus || [];

  for (const sku of actionableTaxonomy) {
    const item = bySku.get(String(sku));
    if (!item) throw new Error(`Actionable taxonomy SKU ${sku} is missing lifecycle evidence`);
    if (item.taxonomy_state !== 'MAPPING_REQUIRED' || !item.requires_seller_action) {
      throw new Error(`Actionable taxonomy SKU ${sku} is not classified MAPPING_REQUIRED`);
    }
    if (item.source_state !== 'SOURCE_READY') {
      throw new Error(
        `Taxonomy was made actionable before source readiness for ${sku}: ${item.source_state}`,
      );
    }
  }

  for (const sku of onboardingTaxonomy) {
    const item = bySku.get(String(sku));
    if (!item) throw new Error(`Onboarding taxonomy SKU ${sku} is missing lifecycle evidence`);
    if (item.taxonomy_state !== 'ONBOARDING' || item.requires_seller_action) {
      throw new Error(`Onboarding SKU ${sku} is not classified as informational onboarding`);
    }
  }

  for (const sku of inactiveTaxonomy) {
    const item = bySku.get(String(sku));
    if (!item) throw new Error(`Inactive taxonomy SKU ${sku} is missing lifecycle evidence`);
    if (item.taxonomy_state !== 'INACTIVE' || item.requires_seller_action) {
      throw new Error(`Inactive SKU ${sku} was incorrectly turned into seller action`);
    }
  }

  for (const sku of sourceAttention) {
    const item = bySku.get(String(sku));
    if (!item?.source_attention || !item.requires_seller_action) {
      throw new Error(`Source-attention SKU ${sku} does not carry source_attention`);
    }
    if (Number(item.age_seconds || 0) < 48 * 3600) {
      throw new Error(`Source-attention SKU ${sku} is younger than the 48h propagation grace`);
    }
  }

  const healthCatalog = health.body.catalog;
  if (!healthCatalog?.summary || !Array.isArray(healthCatalog.items)) {
    throw new Error('Data Health is missing catalog onboarding state');
  }
  if (!healthCatalog.contract?.discovery || !healthCatalog.contract?.grace) {
    throw new Error('Data Health is missing the catalog onboarding contract');
  }
  if (Number(healthCatalog.summary.onboarding || 0) !== Number(lifecycle.summary.onboarding || 0)) {
    throw new Error('Catalog and Data Health disagree on onboarding count');
  }
  if (
    Number(healthCatalog.summary.source_attention || 0) !== Number(lifecycle.summary.source_attention || 0)
  ) {
    throw new Error('Catalog and Data Health disagree on source-attention count');
  }
  if (
    Number(healthCatalog.summary.taxonomy_attention || 0) !==
    Number(lifecycle.summary.taxonomy_attention || 0)
  ) {
    throw new Error('Catalog and Data Health disagree on taxonomy-attention count');
  }

  const summary = {
    ok: true,
    activeListings: lifecycle.summary.active_listings,
    inactiveListings: lifecycle.summary.inactive_listings,
    sourceReady: lifecycle.summary.source_ready,
    onboarding: lifecycle.summary.onboarding,
    sourceAttention: lifecycle.summary.source_attention,
    taxonomyAttention: lifecycle.summary.taxonomy_attention,
    actionableTaxonomy,
    onboardingTaxonomy,
    inactiveTaxonomy,
    sourceAttentionSkus: sourceAttention,
    lifecycle: lifecycle.items.map((item) => ({
      sku: item.sku,
      asin: item.asin,
      sourceState: item.source_state,
      taxonomyState: item.taxonomy_state,
      ageSeconds: item.age_seconds,
      catalogLastAttemptAt: item.catalog_last_attempt_at,
      catalogEnrichedAt: item.catalog_enriched_at,
      requiresSellerAction: item.requires_seller_action,
    })),
  };
  await fs.writeFile(
    path.join(outDir, 'catalog-onboarding-summary.json'),
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify(summary));
} catch (error) {
  const summary = { ok: false, error: error.message };
  await fs.writeFile(
    path.join(outDir, 'catalog-onboarding-summary.json'),
    JSON.stringify(summary, null, 2),
  );
  console.error(error);
  process.exit(1);
}
