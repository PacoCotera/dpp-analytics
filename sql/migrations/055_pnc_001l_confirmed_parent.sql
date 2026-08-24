-- Seller-confirmed relationship while Amazon Catalog Items exposes the child's
-- variation theme/values but has not yet propagated directional parentAsins or
-- the new child in the structural parent's childAsins collection.
UPDATE core.sku
SET parent_asin = 'B0GGQHV45F',
    updated_at = now()
WHERE marketplace_id = 'A1AM78C64UM0Y8'
  AND sku = 'PNC-001L'
  AND asin = 'B0HGBTLT94'
  AND parent_asin IS DISTINCT FROM 'B0GGQHV45F';
