# Catalog configuration findings — 2026-08-28

## Outcome

Seller-owned SKU short names, taxonomy and COGS were stored in three persistent host JSON files with no supported application workflow for editing them. The catalog ingestion and lifecycle contract itself was functioning: new offers enter through the latest complete Seller Listings report, Catalog Items enriches known ASINs and owns parent-child evidence, and SKUs absent from the next completed Listings snapshot become retained deleted history.

The operating defect is the missing management surface, tracked in [#197](https://github.com/PacoCotera/dpp-analytics/issues/197). The release-QA incident that was masking otherwise healthy deployments and skipping downstream audits was separately tracked and production-verified in [#196](https://github.com/PacoCotera/dpp-analytics/issues/196).

## PNC-001L classification

`PNC-001L` was present as a current canonical sellable variation with Amazon source enrichment, parent/family identity, listing status and inventory evidence. It was absent from the seller-owned short-name/taxonomy files and had no configured unit COGS.

- Missing COGS is not a software defect. It is an intentionally blank seller value; the application cannot derive it from Amazon or a sibling SKU.
- Missing seller taxonomy is a configuration task when Amazon source evidence is ready. It becomes a software/source incident only if the current offer is omitted from the management surface, lifecycle is misclassified, or required Amazon source evidence remains unresolved beyond the documented onboarding grace.
- No PNC-001L business value was inferred or copied from a sibling.

## Add/delete behavior

1. A completed merchant-listings report is the authoritative current seller-SKU snapshot.
2. A new current sellable offer appears automatically in Catalog and Admin, even with every seller-owned field blank.
3. Catalog Items enrichment supplies factual ASIN, title, image, variation and parent-child evidence as Amazon propagates it.
4. A SKU missing from the latest completed Listings snapshot is retained with deleted history and excluded from current rollups/editing.
5. Seller configuration is not deleted. If the exact SKU reappears in a later current snapshot, its saved values reattach automatically.
6. Structural parents and seller aliases remain identity context, not editable sellable products.

## Other production evidence

At the time of inspection, the board reported eight current seller offers and fourteen deleted historical records with no overlap. All nine Data Health pipelines were healthy; the only Product attention was the seller-taxonomy mapping for `PNC-001L`. The absence of its COGS was correctly surfaced as configuration readiness rather than an ingestion failure.
