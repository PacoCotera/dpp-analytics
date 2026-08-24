-- Prove that the persisted Catalog hot-path facts are equivalent to the live
-- aggregations they replace. migrate.sh owns the surrounding transaction; make
-- all refresh/compare statements share one source snapshot so concurrent
-- ingestion cannot create a false mismatch.
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;

REFRESH MATERIALIZED VIEW mart.catalog_traffic_t56_cache;
REFRESH MATERIALIZED VIEW mart.catalog_sku_activity_t56_cache;

DO $$
DECLARE
    traffic_mismatches integer;
    sku_mismatches integer;
BEGIN
    WITH cutoff AS (
        SELECT marketplace_id, max(business_date) AS through_date
        FROM core.asin_sales_traffic_daily
        GROUP BY marketplace_id
    ),
    live AS (
        SELECT
            a.marketplace_id,
            a.asin,
            max(NULLIF(a.parent_asin,'')) AS parent_asin,
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
    differences AS (
        (
            SELECT marketplace_id,asin,parent_asin,through_date,
                   sales_t28,units_t28,orders_t28,sessions_t28,page_views_t28,
                   sales_prior_t28,units_prior_t28,sessions_prior_t28
            FROM mart.catalog_traffic_t56_cache
            EXCEPT ALL
            SELECT marketplace_id,asin,parent_asin,through_date,
                   sales_t28,units_t28,orders_t28,sessions_t28,page_views_t28,
                   sales_prior_t28,units_prior_t28,sessions_prior_t28
            FROM live
        )
        UNION ALL
        (
            SELECT marketplace_id,asin,parent_asin,through_date,
                   sales_t28,units_t28,orders_t28,sessions_t28,page_views_t28,
                   sales_prior_t28,units_prior_t28,sessions_prior_t28
            FROM live
            EXCEPT ALL
            SELECT marketplace_id,asin,parent_asin,through_date,
                   sales_t28,units_t28,orders_t28,sessions_t28,page_views_t28,
                   sales_prior_t28,units_prior_t28,sessions_prior_t28
            FROM mart.catalog_traffic_t56_cache
        )
    )
    SELECT count(*)::integer INTO traffic_mismatches FROM differences;

    WITH live AS (
        SELECT
            marketplace_id,
            seller_sku,
            COALESCE(sum(sales) FILTER (WHERE business_date >= current_date - 55),0)::numeric(14,2) AS recent_sales,
            COALESCE(sum(units) FILTER (WHERE business_date >= current_date - 55),0)::bigint AS recent_units
        FROM mart.sku_daily
        GROUP BY marketplace_id, seller_sku
    ),
    differences AS (
        (
            SELECT marketplace_id,seller_sku,recent_sales,recent_units
            FROM mart.catalog_sku_activity_t56_cache
            EXCEPT ALL
            SELECT marketplace_id,seller_sku,recent_sales,recent_units
            FROM live
        )
        UNION ALL
        (
            SELECT marketplace_id,seller_sku,recent_sales,recent_units
            FROM live
            EXCEPT ALL
            SELECT marketplace_id,seller_sku,recent_sales,recent_units
            FROM mart.catalog_sku_activity_t56_cache
        )
    )
    SELECT count(*)::integer INTO sku_mismatches FROM differences;

    IF traffic_mismatches <> 0 OR sku_mismatches <> 0 THEN
        RAISE EXCEPTION
            'Catalog hot-path cache parity failed: traffic mismatches %, sku mismatches %',
            traffic_mismatches,
            sku_mismatches;
    END IF;

    RAISE NOTICE
        'Catalog hot-path cache parity passed: traffic mismatches %, sku mismatches %',
        traffic_mismatches,
        sku_mismatches;
END
$$;
