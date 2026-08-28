from __future__ import annotations

import unittest

from inventory_api import _classify_inventory_rows


class InventoryIdentityTests(unittest.TestCase):
    def setUp(self):
        self.current = [
            {"sku": "PNC-001", "asin": "B0PNC"},
            {"sku": "PNC-005B", "asin": "B0WHITE"},
        ]

    def test_current_stock_bearing_offer_is_default(self):
        rows = _classify_inventory_rows(
            [{"sku": "PNC-001", "asin": "B0PNC", "available": 4, "units_t28": 2}],
            self.current,
            set(),
        )
        self.assertEqual(rows[0]["inventory_lifecycle"], "CURRENT_OFFER")
        self.assertEqual(rows[0]["canonical_sku"], "PNC-001")
        self.assertTrue(rows[0]["is_default_inventory"])

    def test_same_asin_alias_points_to_current_without_becoming_default(self):
        rows = _classify_inventory_rows(
            [{"sku": "PNC-001-D", "asin": "B0PNC", "available": 4, "units_t28": 2}],
            self.current,
            set(),
        )
        self.assertEqual(rows[0]["inventory_lifecycle"], "ALIAS")
        self.assertEqual(rows[0]["canonical_sku"], "PNC-001")
        self.assertFalse(rows[0]["is_default_inventory"])

    def test_retired_and_archived_records_remain_distinct(self):
        rows = _classify_inventory_rows(
            [
                {"sku": "OLD", "asin": "B0OLD", "units_t28": 0},
                {"sku": "ORPHAN", "asin": "B0ORPHAN", "units_t28": 0},
            ],
            self.current,
            {"OLD"},
        )
        self.assertEqual(rows[0]["inventory_lifecycle"], "RETIRED")
        self.assertEqual(rows[1]["inventory_lifecycle"], "ARCHIVED")
        self.assertTrue(all(row["canonical_sku"] is None for row in rows))

    def test_current_zero_stock_is_reference_not_default(self):
        rows = _classify_inventory_rows(
            [{"sku": "PNC-005B", "asin": "B0WHITE", "available": 0, "inbound": 0, "units_t28": 0}],
            self.current,
            set(),
        )
        self.assertTrue(rows[0]["is_current_offer"])
        self.assertFalse(rows[0]["has_stock"])
        self.assertFalse(rows[0]["has_velocity"])
        self.assertFalse(rows[0]["is_default_inventory"])


if __name__ == "__main__":
    unittest.main()
