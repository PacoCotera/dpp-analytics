CREATE TABLE brand.repeat_purchase_behavior (
    marketplace_id text NOT NULL,
    report_period text NOT NULL CHECK (report_period IN ('WEEK','MONTH','QUARTER')),
    start_date date NOT NULL,
    end_date date NOT NULL,
    asin text NOT NULL,
    orders bigint NOT NULL,
    unique_customers bigint NOT NULL,
    repeat_customer_ratio numeric(18,10) NOT NULL,
    repeat_purchase_revenue numeric(14,4) NOT NULL,
    repeat_purchase_revenue_currency char(3) NOT NULL,
    repeat_purchase_revenue_ratio numeric(18,10) NOT NULL,
    revenue_basis text NOT NULL DEFAULT 'ORDERED_REVENUE_RETURNS_EXCLUDED'
        CHECK (revenue_basis='ORDERED_REVENUE_RETURNS_EXCLUDED'),
    tax_basis text NOT NULL DEFAULT 'SOURCE_UNSPECIFIED'
        CHECK (tax_basis='SOURCE_UNSPECIFIED'),
    source_payload_id bigint NOT NULL REFERENCES raw.api_payload(id),
    source_report_id text NOT NULL,
    fetched_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (marketplace_id,report_period,start_date,end_date,asin),
    CHECK (end_date >= start_date),
    CHECK (orders >= 0),
    CHECK (unique_customers >= 0),
    CHECK (repeat_customer_ratio BETWEEN 0 AND 1),
    CHECK (repeat_purchase_revenue >= 0),
    CHECK (repeat_purchase_revenue_currency ~ '^[A-Z]{3}$'),
    CHECK (repeat_purchase_revenue_ratio BETWEEN 0 AND 1)
);

CREATE INDEX brand_repeat_purchase_asin_period_idx
    ON brand.repeat_purchase_behavior(
        marketplace_id,asin,report_period,start_date DESC
    );

COMMENT ON TABLE brand.repeat_purchase_behavior IS
'Amazon Brand Analytics repeat-purchase behavior at exact seller-catalog ASIN and calendar-period grain. It is future portfolio and LTV context, not advertising attribution, contribution, causality or incremental lift.';

COMMENT ON COLUMN brand.repeat_purchase_behavior.orders IS
'Amazon order count; an order can contain multiple quantities and is not an ordered-unit count.';

COMMENT ON COLUMN brand.repeat_purchase_behavior.repeat_purchase_revenue IS
'Amazon ordered revenue from repeat customers. Returns are not reflected and the source does not define a tax basis, so this cannot be used as contribution or advertising return.';

COMMENT ON COLUMN brand.repeat_purchase_behavior.repeat_customer_ratio IS
'Amazon repeatCustomersPctTotal fraction stored as a 0-1 ratio without percentage scaling.';

COMMENT ON COLUMN brand.repeat_purchase_behavior.repeat_purchase_revenue_ratio IS
'Amazon repeatPurchaseRevenuePctTotal fraction stored as a 0-1 ratio without percentage scaling.';
