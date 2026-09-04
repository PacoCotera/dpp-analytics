CREATE TABLE brand.market_basket_affinity (
    marketplace_id text NOT NULL,
    report_period text NOT NULL CHECK (report_period IN ('DAY','WEEK','MONTH','QUARTER')),
    start_date date NOT NULL,
    end_date date NOT NULL,
    asin text NOT NULL,
    purchased_with_asin text NOT NULL,
    purchased_with_rank integer NOT NULL,
    combination_ratio numeric(18,10) NOT NULL,
    source_payload_id bigint NOT NULL REFERENCES raw.api_payload(id),
    source_report_id text NOT NULL,
    fetched_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (
        marketplace_id,report_period,start_date,end_date,asin,purchased_with_asin
    ),
    CHECK (end_date >= start_date),
    CHECK (purchased_with_rank > 0),
    CHECK (combination_ratio BETWEEN 0 AND 1)
);

CREATE INDEX brand_market_basket_asin_period_idx
    ON brand.market_basket_affinity(
        marketplace_id,asin,report_period,start_date DESC,purchased_with_rank
    );

CREATE INDEX brand_market_basket_companion_period_idx
    ON brand.market_basket_affinity(
        marketplace_id,purchased_with_asin,report_period,start_date DESC
    );

COMMENT ON TABLE brand.market_basket_affinity IS
'Amazon Brand Analytics co-purchase affinity at exact owned-ASIN, companion-ASIN and calendar-period grain. It is merchandising and demand context, not advertising attribution, causality or incremental lift.';

COMMENT ON COLUMN brand.market_basket_affinity.asin IS
'ASIN in the selling partner catalog according to the source report.';

COMMENT ON COLUMN brand.market_basket_affinity.purchased_with_asin IS
'ASIN purchased in the same order; it may or may not belong to the selling partner catalog.';

COMMENT ON COLUMN brand.market_basket_affinity.combination_ratio IS
'Amazon combinationPct ratio stored without percentage scaling.';
