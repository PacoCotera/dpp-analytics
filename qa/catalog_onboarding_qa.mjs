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

  const sellable = (catalog.body.products || []).filter(item =>
    ['SELLABLE_VARIATION', 'SELLABLE_STANDALONE'].includes(String(item.product_role || '')),
  );
  const currentListingRecords = (catalog.body.products || []).filter(
    item => item.is_current_listing === true,
  );
  const deletedProducts = catalog.body.deleted_products || [];
  if (
    Number(catalog.body.summary?.listing_records || 0) !== currentListingRecords.length ||
    Number(catalog.body.summary?.sellable_offers || 0) !== sellable.length ||
    Number(catalog.body.summary?.catalog_entities || 0) !== (catalog.body.products || []).length
  ) {
    throw new Error('Catalog summary does not reconcile to the current Amazon snapshot');
  }
  if (Number(catalog.body.summary?.deleted_records || 0) !== deletedProducts.length) {
    throw new Error('Deleted history count does not reconcile to deleted_products');
  }
  if (
    (catalog.body.products || []).some(item => item.catalog_membership === 'DELETED') ||
    deletedProducts.some(item => item.catalog_membership !== 'DELETED')
  ) {
    throw new Error('Current Catalog and deleted history membership are mixed');
  }
  const currentSkus = new Set((catalog.body.products || []).map(item => String(item.sku || '')));
  const deletedSkus = new Set(deletedProducts.map(item => String(item.sku || '')));
  if ([...currentSkus].some(sku => deletedSkus.has(sku))) {
    throw new Error('A seller SKU appears in both current Catalog and deleted history');
  }
  if (Number(catalog.body.summary?.identity_invariant_checked_skus || 0) !== sellable.length) {
    throw new Error('Catalog identity invariant did not check every sellable SKU');
  }
  if (Number(catalog.body.summary?.identity_invariant_violation_count || 0) !== 0) {
    throw new Error(`Catalog identity violations: ${JSON.stringify(catalog.body.identity_violations || [])}`);
  }
  for (const item of sellable) {
    const identity = item.identity || {};
    if (!identity.consistent || identity.role !== item.product_role || !identity.family_label) {
      throw new Error(`Sellable SKU ${item.sku} has no consistent canonical identity`);
    }
    if (
      item.product_role === 'SELLABLE_VARIATION' &&
      (!item.parent_asin || item.parent_asin === item.asin || item.family_asin !== item.parent_asin)
    ) {
      throw new Error(`Child variation ${item.sku} has contradictory parent/family identity`);
    }
    if (
      item.product_role === 'SELLABLE_STANDALONE' &&
      (item.parent_asin || item.family_asin !== item.asin)
    ) {
      throw new Error(`Standalone offer ${item.sku} has contradictory parent/family identity`);
    }
  }

  const structuralParents = (catalog.body.products || []).filter(
    item => item.product_role === 'STRUCTURAL_PARENT',
  );
  if (
    structuralParents.some(
      item => item.is_current_listing !== true && String(item.sku || '').trim(),
    )
  ) {
    throw new Error('A deleted seller SKU was reused as current structural-parent context');
  }
  const structuralParentSkus = new Set(structuralParents.map(item => String(item.sku || '')));
  const auditedParent = structuralParents.find(item => item.asin === 'B0GGQHV45F');
  if (
    !auditedParent ||
    auditedParent.catalog_membership !== 'CURRENT_PARENT' ||
    auditedParent.identity?.kind !== 'VARIATION_CONTAINER' ||
    auditedParent.identity?.is_sellable !== false ||
    auditedParent.is_offer_owner !== false
  ) {
    throw new Error(`Current Pocket relationship has no canonical structural parent: ${JSON.stringify(auditedParent)}`);
  }
  if (currentSkus.has('PNC-CURRENT') || !deletedSkus.has('PNC-CURRENT')) {
    throw new Error('PNC-CURRENT was not separated from the current Amazon Catalog as deleted history');
  }
  const lifecycleParentSkus = (lifecycle.items || [])
    .filter(item => structuralParentSkus.has(String(item.sku || '')))
    .map(item => item.sku);
  if (lifecycleParentSkus.length) {
    throw new Error(`Structural parents leaked into onboarding: ${lifecycleParentSkus.join(', ')}`);
  }
  const parentOnlyFamilies = (catalog.body.families || []).filter(
    family => !(family.members || []).length,
  );
  if (parentOnlyFamilies.length) {
    throw new Error(`Parent-only containers leaked into commercial families: ${JSON.stringify(parentOnlyFamilies)}`);
  }
  if (Number(catalog.body.summary?.families || 0) !== (catalog.body.families || []).length) {
    throw new Error('Commercial family KPI includes a parent-only container');
  }
  for (const family of catalog.body.families || []) {
    if ((family.members || []).some(item => structuralParentSkus.has(String(item.sku || '')))) {
      throw new Error(`Structural parent leaked into sellable family members: ${family.family_asin}`);
    }
    if (
      family.catalog_lifecycle !== 'CURRENT_FAMILY' ||
      JSON.stringify(family.catalog_memberships || []) !== JSON.stringify(['CURRENT_OFFER']) ||
      (family.members || []).some(item => item.catalog_membership !== 'CURRENT_OFFER')
    ) {
      throw new Error(`Current family has non-current lifecycle evidence: ${JSON.stringify(family)}`);
    }
    if (family.needs_attention && family.catalog_lifecycle !== 'CURRENT_FAMILY') {
      throw new Error(`Non-current family entered current attention: ${family.family_asin}`);
    }
  }

  const auditedProduct = await getJson('/api/product?sku=PNC-001L&refresh=1');
  const auditedIdentity = auditedProduct.body.commercial?.identity || {};
  if (
    auditedIdentity.kind !== 'CHILD_VARIATION' ||
    auditedIdentity.family_label === 'Standalone product' ||
    auditedIdentity.parent_asin !== 'B0GGQHV45F' ||
    auditedIdentity.family_asin !== 'B0GGQHV45F'
  ) {
    throw new Error(`PNC-001L canonical identity is contradictory: ${JSON.stringify(auditedIdentity)}`);
  }

  const auditedFamily = (catalog.body.families || []).find(
    family => family.family_asin === 'B0GGQHV45F',
  );
  if (!auditedFamily) throw new Error('Audited Pocket family is missing from Catalog');
  const stock = Number(auditedFamily.available || 0) + Number(auditedFamily.inbound || 0);
  const velocity = Number(auditedFamily.units_t28 || 0);
  const expectedCover = velocity > 0 ? Math.round((stock / (velocity / 28)) * 10) / 10 : null;
  if (
    auditedFamily.cover_basis?.method !== 'POOLED_28D' ||
    Number(auditedFamily.days_cover_with_inbound) !== expectedCover ||
    Number(auditedFamily.cover_basis?.stock_units) !== stock ||
    Number(auditedFamily.cover_basis?.velocity_units_t28) !== velocity
  ) {
    throw new Error(`Pocket family cover does not reconcile: ${JSON.stringify(auditedFamily)}`);
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
    if (
      !['INACTIVE', 'CLOSED', 'INCOMPLETE', 'NOT_ACTIVE'].includes(item.taxonomy_state) ||
      item.requires_seller_action
    ) {
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
    identityInvariantCheckedSkus: sellable.length,
    currentListingRecords: currentListingRecords.length,
    deletedRecords: deletedProducts.length,
    deletedSkus: [...deletedSkus].sort(),
    structuralParentSkus: [...structuralParentSkus].sort(),
    auditedStructuralParent: {
      sku: auditedParent.sku,
      asin: auditedParent.asin,
      role: auditedParent.product_role,
      identity: auditedParent.identity,
    },
    auditedProductIdentity: auditedIdentity,
    auditedFamilyCover: {
      familyAsin: auditedFamily.family_asin,
      stock,
      velocityUnitsT28: velocity,
      daysCover: auditedFamily.days_cover_with_inbound,
      basis: auditedFamily.cover_basis,
    },
    familyLifecycles: (catalog.body.families || []).map(family => ({
      familyAsin: family.family_asin,
      lifecycle: family.catalog_lifecycle,
      memberships: family.catalog_memberships,
      needsAttention: family.needs_attention,
    })),
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
