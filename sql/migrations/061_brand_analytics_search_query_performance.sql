CREATE SCHEMA IF NOT EXISTS brand;

CREATE TABLE brand.search_query_performance (
    marketplace_id text NOT NULL,
    report_period text NOT NULL CHECK (report_period IN ('WEEK','MONTH','QUARTER')),
    start_date date NOT NULL,
    end_date date NOT NULL,
    asin text NOT NULL,
    search_query text NOT NULL,
    search_query_key text NOT NULL,
    search_query_score integer,
    search_query_volume bigint,

    total_query_impression_count bigint,
    asin_impression_count bigint,
    asin_impression_share numeric(18,10),

    total_click_count bigint,
    total_click_rate numeric(18,10),
    asin_click_count bigint,
    asin_click_share numeric(18,10),
    total_median_click_price numeric(14,4),
    asin_median_click_price numeric(14,4),
    click_total_currency char(3),
    click_asin_currency char(3),
    total_same_day_shipping_click_count bigint,
    total_one_day_shipping_click_count bigint,
    total_two_day_shipping_click_count bigint,

    total_cart_add_count bigint,
    total_cart_add_rate numeric(18,10),
    asin_cart_add_count bigint,
    asin_cart_add_share numeric(18,10),
    total_median_cart_add_price numeric(14,4),
    asin_median_cart_add_price numeric(14,4),
    cart_total_currency char(3),
    cart_asin_currency char(3),
    total_same_day_shipping_cart_add_count bigint,
    total_one_day_shipping_cart_add_count bigint,
    total_two_day_shipping_cart_add_count bigint,

    total_purchase_count bigint,
    total_purchase_rate numeric(18,10),
    asin_purchase_count bigint,
    asin_purchase_share numeric(18,10),
    total_median_purchase_price numeric(14,4),
    asin_median_purchase_price numeric(14,4),
    purchase_total_currency char(3),
    purchase_asin_currency char(3),
    total_same_day_shipping_purchase_count bigint,
    total_one_day_shipping_purchase_count bigint,
    total_two_day_shipping_purchase_count bigint,

    source_payload_id bigint NOT NULL REFERENCES raw.api_payload(id),
    source_report_id text NOT NULL,
    fetched_at timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (
        marketplace_id,report_period,start_date,end_date,asin,search_query
    ),
    CHECK (end_date >= start_date)
);

CREATE INDEX brand_search_query_asin_period_idx
    ON brand.search_query_performance(
        marketplace_id,asin,report_period,start_date DESC
    );

CREATE INDEX brand_search_query_key_period_idx
    ON brand.search_query_performance(
        marketplace_id,search_query_key,report_period,start_date DESC
    );

COMMENT ON TABLE brand.search_query_performance IS
'Amazon Brand Analytics Search Query Performance at the exact ASIN, query and calendar-period grain. Amazon-wide query funnel and ASIN funnel share are inclusive search evidence; they do not define organic sales or advertising incrementality.';

COMMENT ON COLUMN brand.search_query_performance.search_query_key IS
'NFKC-normalized, whitespace-collapsed and case-folded join key. search_query preserves Amazon source text.';

COMMENT ON COLUMN brand.search_query_performance.asin_impression_share IS
'Ratio returned by Amazon, stored without percentage scaling.';

COMMENT ON COLUMN brand.search_query_performance.asin_click_share IS
'Ratio returned by Amazon, stored without percentage scaling.';

COMMENT ON COLUMN brand.search_query_performance.asin_cart_add_share IS
'Ratio returned by Amazon, stored without percentage scaling.';

COMMENT ON COLUMN brand.search_query_performance.asin_purchase_share IS
'Ratio returned by Amazon, stored without percentage scaling.';
