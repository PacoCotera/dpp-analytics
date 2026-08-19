CREATE TABLE IF NOT EXISTS core.catalog_item (
    marketplace_id text NOT NULL,
    asin text NOT NULL,
    title text,
    image_url text,
    image_width integer,
    image_height integer,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (marketplace_id, asin)
);

CREATE INDEX IF NOT EXISTS catalog_item_asin_idx
    ON core.catalog_item (asin);
