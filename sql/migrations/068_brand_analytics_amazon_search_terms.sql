CREATE TABLE brand.amazon_search_term (
    marketplace_id text NOT NULL,
    report_period text NOT NULL CHECK (report_period IN ('WEEK','MONTH','QUARTER')),
    start_date date NOT NULL,
    end_date date NOT NULL,
    department_name text NOT NULL,
    search_term text NOT NULL,
    search_term_key text NOT NULL,
    search_frequency_rank bigint,
    clicked_asin text NOT NULL,
    clicked_item_name text,
    click_share_rank integer,
    click_share numeric(18,10),
    conversion_share numeric(18,10),
    source_payload_id bigint NOT NULL REFERENCES raw.api_payload(id),
    source_report_id text NOT NULL,
    fetched_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (
        marketplace_id,report_period,start_date,end_date,
        department_name,search_term,clicked_asin
    ),
    CHECK (end_date >= start_date),
    CHECK (search_frequency_rank IS NULL OR search_frequency_rank > 0),
    CHECK (click_share_rank IS NULL OR click_share_rank > 0),
    CHECK (click_share IS NULL OR click_share BETWEEN 0 AND 1),
    CHECK (conversion_share IS NULL OR conversion_share BETWEEN 0 AND 1)
);

CREATE INDEX brand_amazon_search_term_period_idx
    ON brand.amazon_search_term(
        marketplace_id,search_term_key,report_period,start_date DESC
    );

CREATE INDEX brand_amazon_search_clicked_asin_idx
    ON brand.amazon_search_term(
        marketplace_id,clicked_asin,report_period,start_date DESC
    );

COMMENT ON TABLE brand.amazon_search_term IS
'Amazon Brand Analytics market-level Search Terms at exact query, clicked-ASIN and calendar-period grain. Click and conversion shares are demand context, not advertising attribution or incrementality.';

COMMENT ON COLUMN brand.amazon_search_term.search_term_key IS
'NFKC-normalized, whitespace-collapsed and case-folded join key. search_term preserves Amazon source text.';

COMMENT ON COLUMN brand.amazon_search_term.click_share IS
'Ratio returned by Amazon, stored without percentage scaling.';

COMMENT ON COLUMN brand.amazon_search_term.conversion_share IS
'Ratio returned by Amazon, stored without percentage scaling.';
