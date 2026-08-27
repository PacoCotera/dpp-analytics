from __future__ import annotations

import unittest

from catalog_api import _family_rollup, _pooled_days_cover


class CatalogFamilyCoverTest(unittest.TestCase):
    @staticmethod
    def _member(sku, available, inbound, units_t28):
        return {
            "sku": sku,
            "asin": f"ASIN-{sku}",
            "family_asin": "FAMILY",
            "product_role": "SELLABLE_VARIATION",
            "status": "Active",
            "product": sku,
            "available": available,
            "inbound": inbound,
            "units_t28": units_t28,
            "commercial_state": "HEALTHY",
        }

    def test_mixed_velocity_family_uses_pooled_stock_and_velocity(self):
        # Includes stock belonging to a valid zero-velocity child.
        self.assertEqual(_pooled_days_cover(119, 0, 53), 62.9)

    def test_inbound_is_included_in_pooled_stock(self):
        self.assertEqual(_pooled_days_cover(10, 4, 7), 56.0)

    def test_zero_velocity_is_unavailable_not_zero(self):
        self.assertIsNone(_pooled_days_cover(20, 5, 0))

    def test_missing_velocity_is_unavailable_not_zero(self):
        self.assertIsNone(_pooled_days_cover(20, 5, None))

    def test_rounds_to_one_decimal_day(self):
        self.assertEqual(_pooled_days_cover(1, 0, 6), 4.7)

    def test_family_api_rollup_uses_visible_pooled_operands(self):
        rows = [
            self._member("SELLING", 10, 4, 7),
            self._member("NO-VELOCITY", 6, 0, 0),
        ]

        family = _family_rollup(rows, 0, 0)[0]

        self.assertEqual(family["available"], 16)
        self.assertEqual(family["inbound"], 4)
        self.assertEqual(family["units_t28"], 7)
        self.assertEqual(family["days_cover_with_inbound"], 80.0)
        self.assertEqual(
            family["cover_basis"],
            {
                "method": "POOLED_28D",
                "stock_units": 20,
                "velocity_units_t28": 7,
                "period_days": 28,
            },
        )

    def test_family_api_rollup_reports_no_velocity_without_zero_cover(self):
        family = _family_rollup([self._member("NO-VELOCITY", 12, 3, None)], 0, 0)[0]

        self.assertIsNone(family["days_cover_with_inbound"])
        self.assertEqual(family["cover_basis"]["stock_units"], 15)
        self.assertEqual(family["cover_basis"]["velocity_units_t28"], 0)


if __name__ == "__main__":
    unittest.main()
