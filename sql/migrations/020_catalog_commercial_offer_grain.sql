-- Catalog commercial-offer correction.
--
-- Customer-facing demand/traffic is available reliably at CHILD ASIN grain from
-- Data Kiosk. Seller SKUs are operational identifiers and multiple historical or
-- replacement SKUs may legitimately point at the same ASIN. Therefore:
--   * demand must be joined once per child ASIN;
--   * inventory is summed across seller SKUs that represent that ASIN;
--   * one canonical seller SKU owns the commercial offer for drilldown/economics;
--   * additional seller SKUs are operational aliases, not extra products;
--   * parent ASINs remain structural variation containers and never receive child demand.

CREATE OR REPLACE VIEW mart.catalog_portfolio_product AS
WITH cutoff AS (
    SELECT marketplace_id, max(business_date) AS through_date
    FROM core.asin_sales_traffic_daily
    GROUP BY marketplace_id
),
asin_traffic AS (
    SELECT
        a.marketplace_id,
        a.asin,
        max(a.parent_asin) FILTER (WHERE a.parent_asin IS NOT NULL AND a.parent_asin <> '') AS parent_asin,
        c.through_date,
        COALESCE(sum(a.ordered_product_sales) FILTER (
            WHERE a.business_date BETWEEN c.through_date - 27 AND c.through_date
        ),0)::numeric(14,2) AS sales_t28,
        COALESCE(sum(a.units_ordered) FILTER (
            WHERE a.business_date BETWEEN c.through_date - 27 AND c.through_date
        ),0)::bigint AS units_t28,
        COALESCE(sum(a.total_order_items) FILTER (
            WHERE a.business_date BETWEEN c.through_date - 27 AND c.through_date
        ),0)::bigint AS orders_t28,
        COALESCE(sum(a.sessions) FILTER (
            WHERE a.business_date BETWEEN c.through_date - 27 AND c.through_date
        ),0)::bigint AS sessions_t28,
        COALESCE(sum(a.page_views) FILTER (
            WHERE a.business_date BETWEEN c.through_date - 27 AND c.through_date
        ),0)::bigint AS page_views_t28,
        COALESCE(sum(a.ordered_product_sales) FILTER (
            WHERE a.business_date BETWEEN c.through_date - 55 AND c.through_date - 28
        ),0)::numeric(14,2) AS sales_prior_t28,
        COALESCE(sum(a.units_ordered) FILTER (
            WHERE a.business_date BETWEEN c.through_date - 55 AND c.through_date - 28
        ),0)::bigint AS units_prior_t28,
        COALESCE(sum(a.sessions) FILTER (
            WHERE a.business_date BETWEEN c.through_date - 55 AND c.through_date - 28
        ),0)::bigint AS sessions_prior_t28
    FROM core.asin_sales_traffic_daily a
    JOIN cutoff c USING (marketplace_id)
    WHERE a.business_date BETWEEN c.through_date - 55 AND c.through_date
    GROUP BY a.marketplace_id, a.asin, c.through_date
),
parents AS (
    SELECT DISTINCT marketplace_id, parent_asin AS asin
    FROM core.asin_sales_traffic_daily
    WHERE parent_asin IS NOT NULL AND parent_asin <> '' AND parent_asin <> asin
),
ranked_listing AS (
    SELECT
        sc.*,
        row_number() OVER (
            PARTITION BY sc.marketplace_id, sc.asin
            ORDER BY
                CASE WHEN lower(COALESCE(sc.status,'')) <> 'inactive' THEN 0 ELSE 1 END,
                CASE WHEN COALESCE(sc.active,true) THEN 0 ELSE 1 END,
                sc.fetched_at DESC NULLS LAST,
                sc.open_date DESC NULLS LAST,
                sc.seller_sku
        ) AS offer_rank,
        first_value(sc.seller_sku) OVER (
            PARTITION BY sc.marketplace_id, sc.asin
            ORDER BY
                CASE WHEN lower(COALESCE(sc.status,'')) <> 'inactive' THEN 0 ELSE 1 END,
                CASE WHEN COALESCE(sc.active,true) THEN 0 ELSE 1 END,
                sc.fetched_at DESC NULLS LAST,
                sc.open_date DESC NULLS LAST,
                sc.seller_sku
        ) AS offer_owner_sku
    FROM mart.seller_catalog sc
    WHERE sc.asin IS NOT NULL AND sc.asin <> ''
),
offer_inventory AS (
    SELECT
        r.marketplace_id,
        r.asin,
        COALESCE(sum(i.available),0)::int AS available,
        COALESCE(sum(i.inbound),0)::int AS inbound,
        min(i.days_cover_on_hand) FILTER (WHERE i.days_cover_on_hand IS NOT NULL) AS min_days_cover_on_hand,
        min(i.days_cover_with_inbound) FILTER (WHERE i.days_cover_with_inbound IS NOT NULL) AS min_days_cover_with_inbound,
        CASE min(CASE COALESCE(i.action,'HOLD')
            WHEN 'STOCKOUT' THEN 0 WHEN 'PRODUCE' THEN 1 WHEN 'PLAN' THEN 2 ELSE 3 END)
            WHEN 0 THEN 'STOCKOUT' WHEN 1 THEN 'PRODUCE' WHEN 2 THEN 'PLAN' ELSE 'HOLD' END AS inventory_action
    FROM ranked_listing r
    LEFT JOIN mart.inventory_attention i
      ON i.marketplace_id=r.marketplace_id AND i.seller_sku=r.seller_sku
    GROUP BY r.marketplace_id, r.asin
)
SELECT
    r.marketplace_id,
    r.seller_sku,
    r.asin,
    t.parent_asin,
    COALESCE(NULLIF(t.parent_asin,''), r.asin) AS family_asin,
    CASE
        WHEN p.asin IS NOT NULL THEN 'STRUCTURAL_PARENT'
        WHEN r.offer_rank > 1 THEN 'SELLER_SKU_ALIAS'
        WHEN t.parent_asin IS NOT NULL AND t.parent_asin <> r.asin THEN 'SELLABLE_VARIATION'
        ELSE 'SELLABLE_STANDALONE'
    END AS product_role,
    r.offer_rank,
    r.offer_owner_sku,
    (r.offer_rank = 1) AS is_offer_owner,
    r.title,
    -- Exact-ASIN Catalog Items media is authoritative. The seller listing image
    -- is accepted only as an exact seller-SKU/ASIN fallback; no parent/sibling lookup.
    COALESCE(ci.image_url, r.image_url) AS image_url,
    CASE WHEN ci.image_url IS NOT NULL THEN 'CATALOG_ITEM_EXACT_ASIN'
         WHEN r.image_url IS NOT NULL THEN 'SELLER_LISTING_EXACT_SKU'
         ELSE NULL END AS image_source,
    r.price,
    r.status,
    r.fulfillment_channel,
    r.open_date,
    r.fetched_at,
    CASE WHEN r.offer_rank = 1 THEN COALESCE(oi.available,0) ELSE 0 END::int AS available,
    CASE WHEN r.offer_rank = 1 THEN COALESCE(oi.inbound,0) ELSE 0 END::int AS inbound,
    CASE WHEN r.offer_rank = 1 THEN oi.min_days_cover_on_hand END AS days_cover_on_hand,
    CASE WHEN r.offer_rank = 1 THEN oi.min_days_cover_with_inbound END AS days_cover_with_inbound,
    CASE WHEN r.offer_rank = 1 THEN COALESCE(oi.inventory_action,'HOLD') ELSE 'ALIAS' END AS inventory_action,
    CASE WHEN r.offer_rank = 1 AND p.asin IS NULL THEN COALESCE(t.sales_t28,0) ELSE 0 END::numeric(14,2) AS sales_t28,
    CASE WHEN r.offer_rank = 1 AND p.asin IS NULL THEN COALESCE(t.units_t28,0) ELSE 0 END::bigint AS units_t28,
    CASE WHEN r.offer_rank = 1 AND p.asin IS NULL THEN COALESCE(t.orders_t28,0) ELSE 0 END::bigint AS orders_t28,
    CASE WHEN r.offer_rank = 1 AND p.asin IS NULL THEN COALESCE(t.sessions_t28,0) ELSE 0 END::bigint AS sessions_t28,
    CASE WHEN r.offer_rank = 1 AND p.asin IS NULL THEN COALESCE(t.page_views_t28,0) ELSE 0 END::bigint AS page_views_t28,
    CASE WHEN r.offer_rank = 1 AND p.asin IS NULL AND COALESCE(t.sessions_t28,0) > 0
         THEN round(100.0 * t.units_t28 / t.sessions_t28, 2)
    END AS conversion_t28_pct,
    CASE WHEN r.offer_rank = 1 AND p.asin IS NULL AND COALESCE(t.sales_prior_t28,0) > 0
         THEN round(100.0 * (t.sales_t28 - t.sales_prior_t28) / t.sales_prior_t28, 1)
         WHEN r.offer_rank = 1 AND p.asin IS NULL AND COALESCE(t.sales_t28,0) = 0 THEN 0::numeric
    END AS sales_delta28_pct,
    CASE WHEN r.offer_rank = 1 AND p.asin IS NULL AND COALESCE(t.sessions_prior_t28,0) > 0
         THEN round(100.0 * (t.sessions_t28 - t.sessions_prior_t28) / t.sessions_prior_t28, 1)
         WHEN r.offer_rank = 1 AND p.asin IS NULL AND COALESCE(t.sessions_t28,0) = 0 THEN 0::numeric
    END AS sessions_delta28_pct,
    CASE WHEN r.offer_rank = 1 AND p.asin IS NULL AND COALESCE(t.sessions_prior_t28,0) > 0 AND COALESCE(t.sessions_t28,0) > 0
         THEN round((100.0 * t.units_t28 / t.sessions_t28) - (100.0 * t.units_prior_t28 / t.sessions_prior_t28), 2)
    END AS conversion_delta28_pp,
    t.through_date AS traffic_through_date,
    (ci.asin IS NOT NULL) AS catalog_enriched
FROM ranked_listing r
LEFT JOIN asin_traffic t ON t.marketplace_id=r.marketplace_id AND t.asin=r.asin
LEFT JOIN parents p ON p.marketplace_id=r.marketplace_id AND p.asin=r.asin
LEFT JOIN offer_inventory oi ON oi.marketplace_id=r.marketplace_id AND oi.asin=r.asin
LEFT JOIN core.catalog_item ci ON ci.marketplace_id=r.marketplace_id AND ci.asin=r.asin;

COMMENT ON VIEW mart.catalog_portfolio_product IS
'Commercial offer model: one customer-facing demand owner per child ASIN, seller-SKU aliases suppressed from demand, inventory rolled up across aliases, structural parents excluded from sellable metrics.';
