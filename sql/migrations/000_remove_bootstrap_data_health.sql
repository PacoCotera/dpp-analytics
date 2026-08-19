-- The bootstrap schema created an earlier ops.data_health shape.
-- Drop it before the canonical warehouse migration replaces it.
DROP VIEW IF EXISTS ops.data_health;
