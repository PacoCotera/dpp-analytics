-- GET_MERCHANT_LISTINGS_ALL_DATA is a complete Amazon seller-catalog snapshot.
-- Keep prior SKU rows for historical attribution, but record whether each SKU
-- is still present in the latest snapshot. Amazon's listing status remains a
-- separate source field so Active / Inactive / Closed are never conflated with
-- a SKU that has been deleted from the seller catalog.

ALTER TABLE core.seller_listing
    ADD COLUMN IF NOT EXISTS is_current_listing boolean NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

WITH latest_ids AS (
        SELECT marketplace_id, max(source_payload_id) AS source_payload_id
        FROM core.seller_listing
        WHERE source_payload_id IS NOT NULL
        GROUP BY marketplace_id
),
latest AS (
    SELECT latest_ids.marketplace_id,
           latest_ids.source_payload_id,
           p.fetched_at AS snapshot_fetched_at
    FROM latest_ids
    LEFT JOIN raw.api_payload p ON p.id=latest_ids.source_payload_id
)
UPDATE core.seller_listing l
SET is_current_listing=COALESCE(l.source_payload_id=latest.source_payload_id,false),
    deleted_at=CASE
        WHEN l.source_payload_id=latest.source_payload_id THEN NULL
        ELSE COALESCE(l.deleted_at,latest.snapshot_fetched_at,CURRENT_TIMESTAMP)
    END
FROM latest
WHERE l.marketplace_id=latest.marketplace_id;

UPDATE core.sku s
SET active=(l.is_current_listing AND lower(COALESCE(l.status,''))='active'),
    updated_at=CURRENT_TIMESTAMP
FROM core.seller_listing l
WHERE s.marketplace_id=l.marketplace_id
  AND s.sku=l.seller_sku
  AND s.active IS DISTINCT FROM
      (l.is_current_listing AND lower(COALESCE(l.status,''))='active');

-- Reconcile the parent link immediately from the latest Catalog Items data
-- already stored in core.catalog_item. Amazon may place the same variation
-- evidence on a child (parentAsins), a parent (childAsins), or both. Multiple
-- distinct parents fail closed to NULL; a Catalog item with no current
-- relationship also clears any older local parent value.
WITH variation_relationships AS (
    SELECT
        ci.marketplace_id,
        ci.asin AS source_asin,
        relationship.value AS relationship
    FROM core.catalog_item ci
    CROSS JOIN LATERAL jsonb_array_elements(
        COALESCE(ci.relationships,'[]'::jsonb)
    ) marketplace_group(value)
    CROSS JOIN LATERAL jsonb_array_elements(
        COALESCE(marketplace_group.value->'relationships','[]'::jsonb)
    ) relationship(value)
    WHERE upper(COALESCE(relationship.value->>'type',''))='VARIATION'
      AND (
        NULLIF(marketplace_group.value->>'marketplaceId','') IS NULL
        OR marketplace_group.value->>'marketplaceId'=ci.marketplace_id
      )
),
relationship_evidence AS (
    SELECT
        marketplace_id,
        source_asin AS child_asin,
        btrim(parent.value) AS parent_asin
    FROM variation_relationships
    CROSS JOIN LATERAL jsonb_array_elements_text(
        COALESCE(relationship->'parentAsins','[]'::jsonb)
    ) parent(value)
    WHERE NULLIF(btrim(parent.value),'') IS NOT NULL

    UNION ALL

    SELECT
        marketplace_id,
        btrim(child.value) AS child_asin,
        source_asin AS parent_asin
    FROM variation_relationships
    CROSS JOIN LATERAL jsonb_array_elements_text(
        COALESCE(relationship->'childAsins','[]'::jsonb)
    ) child(value)
    WHERE NULLIF(btrim(child.value),'') IS NOT NULL
),
resolved_relationships AS (
    SELECT
        marketplace_id,
        child_asin,
        CASE WHEN count(DISTINCT parent_asin)=1 THEN min(parent_asin) END AS parent_asin
    FROM relationship_evidence
    WHERE child_asin<>parent_asin
    GROUP BY marketplace_id,child_asin
),
catalog_asins AS (
    SELECT marketplace_id,asin
    FROM core.catalog_item
    UNION
    SELECT marketplace_id,child_asin
    FROM relationship_evidence
),
relationship_snapshot AS (
    SELECT a.marketplace_id,a.asin,r.parent_asin
    FROM catalog_asins a
    LEFT JOIN resolved_relationships r
      ON r.marketplace_id=a.marketplace_id AND r.child_asin=a.asin
)
UPDATE core.sku s
SET parent_asin=relationship_snapshot.parent_asin,
    updated_at=CURRENT_TIMESTAMP
FROM relationship_snapshot
WHERE s.marketplace_id=relationship_snapshot.marketplace_id
  AND s.asin=relationship_snapshot.asin
  AND s.parent_asin IS DISTINCT FROM relationship_snapshot.parent_asin;

CREATE INDEX IF NOT EXISTS seller_listing_current_idx
    ON core.seller_listing(marketplace_id,is_current_listing,seller_sku);

CREATE OR REPLACE VIEW mart.seller_catalog AS
SELECT
    l.marketplace_id,
    l.seller_sku,
    l.asin,
    l.listing_id,
    COALESCE(l.item_name,s.title,l.seller_sku) AS title,
    l.item_description,
    COALESCE(l.image_url,ci.image_url) AS image_url,
    l.price,
    l.quantity,
    l.pending_quantity,
    l.open_date,
    l.item_condition,
    l.fulfillment_channel,
    l.merchant_shipping_group,
    l.status,
    l.fetched_at,
    s.active,
    l.is_current_listing,
    l.deleted_at
FROM core.seller_listing l
LEFT JOIN core.sku s ON s.sku=l.seller_sku
LEFT JOIN core.catalog_item ci
  ON ci.marketplace_id=l.marketplace_id AND ci.asin=l.asin;

-- Onboarding is only about records in Amazon's current seller-catalog
-- snapshot. Deleted history remains in core.seller_listing and is not a source
-- readiness or taxonomy action.
CREATE OR REPLACE VIEW mart.catalog_onboarding_state AS
SELECT
    l.marketplace_id,
    l.seller_sku,
    l.asin,
    l.status,
    l.first_seen_at,
    l.fetched_at AS listing_fetched_at,
    a.last_attempt_at AS catalog_last_attempt_at,
    COALESCE(a.last_returned_at,ci.catalog_enriched_at) AS catalog_enriched_at,
    CASE
      WHEN lower(COALESCE(l.status,'')) = 'inactive' THEN 'INACTIVE'
      WHEN lower(COALESCE(l.status,'')) = 'closed' THEN 'CLOSED'
      WHEN lower(COALESCE(l.status,'')) = 'incomplete' THEN 'INCOMPLETE'
      WHEN lower(COALESCE(l.status,'')) <> 'active' THEN 'NOT_ACTIVE'
      WHEN NULLIF(btrim(l.asin),'') IS NULL THEN 'AWAITING_ASIN'
      WHEN a.last_attempt_at IS NULL THEN 'AWAITING_CATALOG'
      WHEN ci.asin IS NULL OR COALESCE(a.last_returned_at,ci.catalog_enriched_at) IS NULL
        THEN 'CATALOG_PROPAGATING'
      ELSE 'SOURCE_READY'
    END AS source_state,
    extract(epoch FROM (CURRENT_TIMESTAMP-l.first_seen_at))::bigint AS age_seconds,
    (l.first_seen_at >= CURRENT_TIMESTAMP-interval '48 hours') AS is_onboarding,
    (
      lower(COALESCE(l.status,'')) = 'active'
      AND l.first_seen_at < CURRENT_TIMESTAMP-interval '48 hours'
      AND (
        NULLIF(btrim(l.asin),'') IS NULL
        OR a.last_attempt_at IS NULL
        OR ci.asin IS NULL
        OR COALESCE(a.last_returned_at,ci.catalog_enriched_at) IS NULL
      )
    ) AS source_attention
FROM core.seller_listing l
LEFT JOIN ops.catalog_item_attempt a
  ON a.marketplace_id=l.marketplace_id AND a.asin=l.asin
LEFT JOIN core.catalog_item ci
  ON ci.marketplace_id=l.marketplace_id AND ci.asin=l.asin
WHERE l.is_current_listing;

COMMENT ON VIEW mart.catalog_onboarding_state IS
'Current Amazon seller-catalog onboarding lifecycle. Deleted historical SKUs are retained in core.seller_listing but excluded from onboarding, health and taxonomy action counts.';

-- Commercial Catalog scope is the latest Amazon listings snapshot plus only
-- those structural parents referenced by a current child relationship. The
-- live Catalog Items relationship persisted on core.sku owns parentage;
-- historical Sales & Traffic cannot revive a deleted family.
CREATE OR REPLACE VIEW mart.catalog_portfolio_product AS
WITH current_relationships AS (
    SELECT DISTINCT
        sc.marketplace_id,
        NULLIF(s.parent_asin,'') AS parent_asin
    FROM mart.seller_catalog sc
    LEFT JOIN core.sku s
      ON s.marketplace_id=sc.marketplace_id AND s.sku=sc.seller_sku
    WHERE sc.is_current_listing
      AND NULLIF(s.parent_asin,'') IS NOT NULL
      AND s.parent_asin <> sc.asin
),
parent_catalog_rows AS (
    SELECT
        p.marketplace_id,
        NULL::text AS seller_sku,
        p.parent_asin AS asin,
        NULL::text AS listing_id,
        COALESCE(ci.title,p.parent_asin) AS title,
        NULL::text AS item_description,
        ci.image_url,
        NULL::numeric(14,2) AS price,
        NULL::integer AS quantity,
        NULL::integer AS pending_quantity,
        NULL::date AS open_date,
        NULL::text AS item_condition,
        NULL::text AS fulfillment_channel,
        NULL::text AS merchant_shipping_group,
        'Parent'::text AS status,
        NULL::timestamptz AS fetched_at,
        false AS active,
        false AS is_current_listing,
        NULL::timestamptz AS deleted_at
    FROM current_relationships p
    LEFT JOIN core.catalog_item ci
      ON ci.marketplace_id=p.marketplace_id AND ci.asin=p.parent_asin
    WHERE NOT EXISTS (
        SELECT 1
        FROM mart.seller_catalog current_parent
        WHERE current_parent.marketplace_id=p.marketplace_id
          AND current_parent.asin=p.parent_asin
          AND current_parent.is_current_listing
    )
),
catalog_scope AS (
    SELECT sc.*
    FROM mart.seller_catalog sc
    WHERE sc.is_current_listing
    UNION ALL
    SELECT p.*
    FROM parent_catalog_rows p
),
ranked AS (
    SELECT
        sc.*,
        COALESCE(i.available,0)::int AS available,
        COALESCE(i.inbound,0)::int AS inbound,
        i.days_cover_on_hand,
        i.days_cover_with_inbound,
        COALESCE(i.action,'HOLD') AS inventory_action,
        row_number() OVER (
            PARTITION BY sc.marketplace_id,sc.asin
            ORDER BY
                sc.is_current_listing DESC,
                (COALESCE(sa.recent_units,0) > 0) DESC,
                COALESCE(sa.recent_units,0) DESC,
                (COALESCE(i.available,0)+COALESCE(i.inbound,0) > 0) DESC,
                (lower(COALESCE(sc.status,''))='active') DESC,
                sc.fetched_at DESC,
                sc.open_date DESC NULLS LAST,
                sc.seller_sku
        )::int AS offer_rank
    FROM catalog_scope sc
    LEFT JOIN mart.catalog_sku_activity_t56_cache sa
      ON sa.marketplace_id=sc.marketplace_id AND sa.seller_sku=sc.seller_sku
    LEFT JOIN mart.inventory_attention i
      ON i.marketplace_id=sc.marketplace_id AND i.seller_sku=sc.seller_sku
),
identified AS (
    SELECT
        r.*,
        NULLIF(s.parent_asin,'') AS resolved_parent_asin,
        t.through_date,
        t.sales_t28,
        t.units_t28,
        t.orders_t28,
        t.sessions_t28,
        t.page_views_t28,
        t.sales_prior_t28,
        t.units_prior_t28,
        t.sessions_prior_t28,
        (p.parent_asin IS NOT NULL) AS is_current_parent
    FROM ranked r
    LEFT JOIN core.sku s
      ON s.marketplace_id=r.marketplace_id AND s.sku=r.seller_sku
    LEFT JOIN mart.catalog_traffic_t56_cache t
      ON t.marketplace_id=r.marketplace_id AND t.asin=r.asin
    LEFT JOIN current_relationships p
      ON p.marketplace_id=r.marketplace_id AND p.parent_asin=r.asin
),
owners AS (
    SELECT marketplace_id,asin,seller_sku AS offer_owner_sku
    FROM identified
    WHERE is_current_listing AND NOT is_current_parent AND offer_rank=1
)
SELECT
    r.marketplace_id,
    r.seller_sku,
    r.asin,
    r.resolved_parent_asin AS parent_asin,
    CASE
        WHEN r.is_current_parent THEN r.asin
        ELSE COALESCE(r.resolved_parent_asin,r.asin)
    END AS family_asin,
    CASE
        WHEN r.is_current_parent THEN 'STRUCTURAL_PARENT'
        WHEN r.offer_rank > 1 THEN 'SELLER_SKU_ALIAS'
        WHEN r.resolved_parent_asin IS NOT NULL AND r.resolved_parent_asin <> r.asin
          THEN 'SELLABLE_VARIATION'
        ELSE 'SELLABLE_STANDALONE'
    END AS product_role,
    r.offer_rank,
    o.offer_owner_sku,
    (r.is_current_listing AND NOT r.is_current_parent AND r.offer_rank=1) AS is_offer_owner,
    r.title,
    COALESCE(ci.image_url,r.image_url) AS image_url,
    CASE WHEN ci.image_url IS NOT NULL THEN 'CATALOG_EXACT_ASIN'
         WHEN r.image_url IS NOT NULL THEN 'SELLER_LISTING_EXACT_ASIN'
         ELSE 'NONE' END AS image_source,
    r.price,
    r.status,
    r.fulfillment_channel,
    r.open_date,
    r.fetched_at,
    r.available,
    r.inbound,
    r.days_cover_on_hand,
    r.days_cover_with_inbound,
    r.inventory_action,
    CASE WHEN r.is_current_listing AND NOT r.is_current_parent AND r.offer_rank=1
         THEN COALESCE(r.sales_t28,0) ELSE 0 END::numeric(14,2) AS sales_t28,
    CASE WHEN r.is_current_listing AND NOT r.is_current_parent AND r.offer_rank=1
         THEN COALESCE(r.units_t28,0) ELSE 0 END::bigint AS units_t28,
    CASE WHEN r.is_current_listing AND NOT r.is_current_parent AND r.offer_rank=1
         THEN COALESCE(r.orders_t28,0) ELSE 0 END::bigint AS orders_t28,
    CASE WHEN r.is_current_listing AND NOT r.is_current_parent AND r.offer_rank=1
         THEN COALESCE(r.sessions_t28,0) ELSE 0 END::bigint AS sessions_t28,
    CASE WHEN r.is_current_listing AND NOT r.is_current_parent AND r.offer_rank=1
         THEN COALESCE(r.page_views_t28,0) ELSE 0 END::bigint AS page_views_t28,
    CASE WHEN r.is_current_listing AND NOT r.is_current_parent AND r.offer_rank=1
               AND COALESCE(r.sessions_t28,0)>0
         THEN round(100.0*r.units_t28/r.sessions_t28,2) END AS conversion_t28_pct,
    CASE WHEN NOT r.is_current_listing OR r.is_current_parent OR r.offer_rank<>1 THEN NULL
         WHEN COALESCE(r.sales_prior_t28,0)>0
           THEN round(100.0*(r.sales_t28-r.sales_prior_t28)/r.sales_prior_t28,1)
         WHEN COALESCE(r.sales_t28,0)>0 THEN NULL ELSE 0::numeric END AS sales_delta28_pct,
    CASE WHEN NOT r.is_current_listing OR r.is_current_parent OR r.offer_rank<>1 THEN NULL
         WHEN COALESCE(r.sessions_prior_t28,0)>0
           THEN round(100.0*(r.sessions_t28-r.sessions_prior_t28)/r.sessions_prior_t28,1)
         WHEN COALESCE(r.sessions_t28,0)>0 THEN NULL ELSE 0::numeric END AS sessions_delta28_pct,
    CASE WHEN r.is_current_listing AND NOT r.is_current_parent AND r.offer_rank=1
               AND COALESCE(r.sessions_prior_t28,0)>0 AND COALESCE(r.sessions_t28,0)>0
         THEN round((100.0*r.units_t28/r.sessions_t28)-
                    (100.0*r.units_prior_t28/r.sessions_prior_t28),2) END AS conversion_delta28_pp,
    CASE WHEN r.is_current_listing AND NOT r.is_current_parent AND r.offer_rank=1
         THEN r.through_date ELSE NULL END AS traffic_through_date,
    (ci.asin IS NOT NULL) AS catalog_enriched,
    r.is_current_listing,
    r.deleted_at,
    CASE
      WHEN r.is_current_parent THEN 'CURRENT_PARENT'
      WHEN r.offer_rank=1 THEN 'CURRENT_OFFER'
      ELSE 'CURRENT_ALIAS'
    END AS catalog_membership
FROM identified r
LEFT JOIN owners o USING (marketplace_id,asin)
LEFT JOIN core.catalog_item ci
  ON ci.marketplace_id=r.marketplace_id AND ci.asin=r.asin;

COMMENT ON VIEW mart.catalog_portfolio_product IS
'Current Amazon commercial Catalog identity. Scope is the latest complete seller-listings snapshot plus ASIN-only structural parents referenced by current Catalog Items relationships. Deleted seller SKUs remain only in core/mart seller history and never supply current hierarchy rows.';
