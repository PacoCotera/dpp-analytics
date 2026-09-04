CREATE TABLE brand.search_catalog_performance (
    marketplace_id text NOT NULL,
    report_period text NOT NULL CHECK (report_period IN ('WEEK','MONTH','QUARTER')),
    start_date date NOT NULL,
    end_date date NOT NULL,
    asin text NOT NULL,
    impression_count bigint,
    impression_median_price numeric(14,4),
    impression_currency char(3),
    same_day_shipping_impression_count bigint,
    one_day_shipping_impression_count bigint,
    two_day_shipping_impression_count bigint,
    click_count bigint,
    click_rate numeric(18,10),
    clicked_median_price numeric(14,4),
    click_currency char(3),
    same_day_shipping_click_count bigint,
    one_day_shipping_click_count bigint,
    two_day_shipping_click_count bigint,
    cart_add_count bigint,
    cart_added_median_price numeric(14,4),
    cart_currency char(3),
    same_day_shipping_cart_add_count bigint,
    one_day_shipping_cart_add_count bigint,
    two_day_shipping_cart_add_count bigint,
    purchase_count bigint,
    conversion_rate numeric(18,10),
    purchase_median_price numeric(14,4),
    purchase_currency char(3),
    search_traffic_sales numeric(14,4),
    search_traffic_sales_currency char(3),
    same_day_shipping_purchase_count bigint,
    one_day_shipping_purchase_count bigint,
    two_day_shipping_purchase_count bigint,
    source_payload_id bigint NOT NULL REFERENCES raw.api_payload(id),
    source_report_id text NOT NULL,
    fetched_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (marketplace_id,report_period,start_date,end_date,asin),
    CHECK (end_date >= start_date),
    CHECK (click_rate IS NULL OR click_rate BETWEEN 0 AND 1),
    CHECK (conversion_rate IS NULL OR conversion_rate BETWEEN 0 AND 1),
    CHECK (impression_count IS NULL OR impression_count >= 0),
    CHECK (click_count IS NULL OR click_count >= 0),
    CHECK (cart_add_count IS NULL OR cart_add_count >= 0),
    CHECK (purchase_count IS NULL OR purchase_count >= 0),
    CHECK (search_traffic_sales IS NULL OR search_traffic_sales >= 0)
);

CREATE INDEX brand_search_catalog_asin_period_idx
    ON brand.search_catalog_performance(marketplace_id,asin,report_period,start_date DESC);

COMMENT ON TABLE brand.search_catalog_performance IS
'Amazon Brand Analytics Search Catalog Performance at exact ASIN and calendar-period grain. It is inclusive search-funnel evidence; search traffic sales are neither organic sales nor advertising incrementality.';

COMMENT ON COLUMN brand.search_catalog_performance.search_traffic_sales IS
'Amazon search-traffic sales for the ASIN and exact period. Never interpret as organic-only or incremental advertising sales.';

COMMENT ON COLUMN brand.search_catalog_performance.click_rate IS
'Ratio returned by Amazon, stored without percentage scaling.';

COMMENT ON COLUMN brand.search_catalog_performance.conversion_rate IS
'Ratio returned by Amazon, stored without percentage scaling.';
