-- Canonical seller-owned catalog / offer facts from the Reports API.
-- GET_MERCHANT_LISTINGS_ALL_DATA is the bulk source for our own listings.
-- Catalog Items remains optional enrichment for Amazon catalog metadata.

CREATE TABLE IF NOT EXISTS core.seller_listing (
    marketplace_id text NOT NULL REFERENCES core.marketplace(marketplace_id),
    seller_sku text NOT NULL,
    asin text,
    listing_id text,
    item_name text,
    item_description text,
    price numeric(14,2),
    quantity integer,
    pending_quantity integer,
    image_url text,
    open_date date,
    item_condition text,
    fulfillment_channel text,
    merchant_shipping_group text,
    status text,
    source_payload_id bigint REFERENCES raw.api_payload(id),
    fetched_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (marketplace_id, seller_sku)
);

CREATE INDEX IF NOT EXISTS seller_listing_asin_idx
    ON core.seller_listing (marketplace_id, asin)
    WHERE asin IS NOT NULL;
CREATE INDEX IF NOT EXISTS seller_listing_status_idx
    ON core.seller_listing (marketplace_id, status);

CREATE OR REPLACE VIEW mart.seller_catalog AS
SELECT
    l.marketplace_id,
    l.seller_sku,
    l.asin,
    l.listing_id,
    COALESCE(l.item_name, s.title, l.seller_sku) AS title,
    l.item_description,
    COALESCE(l.image_url, ci.image_url) AS image_url,
    l.price,
    l.quantity,
    l.pending_quantity,
    l.open_date,
    l.item_condition,
    l.fulfillment_channel,
    l.merchant_shipping_group,
    l.status,
    l.fetched_at,
    s.active
FROM core.seller_listing l
LEFT JOIN core.sku s ON s.sku=l.seller_sku
LEFT JOIN core.catalog_item ci
  ON ci.marketplace_id=l.marketplace_id AND ci.asin=l.asin;
