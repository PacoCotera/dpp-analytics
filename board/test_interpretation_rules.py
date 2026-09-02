from __future__ import annotations

import unittest
from datetime import date

from interpretation_rules import (
    RULES,
    business_momentum,
    catalog_dimension_conversion,
    catalog_offer_state,
    eligible_exposure_days,
    sales_breadth,
    sales_concentration,
    sales_product_change,
    today_business_context,
    today_pace,
    trajectory_structure,
)


class InterpretationRuleTest(unittest.TestCase):
    def test_every_rule_is_named_versioned_and_complete(self):
        for rule_id, rule in RULES.items():
            with self.subTest(rule_id=rule_id):
                self.assertEqual(rule["id"], rule_id)
                self.assertGreaterEqual(rule["version"], 1)
                self.assertTrue(rule["inputs"])
                self.assertTrue(rule["window"])
                self.assertTrue(rule["thresholds"])
                self.assertEqual(set(rule["inputs"]), set(rule["input_labels"]))
                self.assertTrue(
                    all("_" not in label for label in rule["input_labels"].values())
                )
                self.assertNotRegex(
                    " ".join(rule["thresholds"]),
                    r">=|<=|\bmax\s*\(|\d(?:\.\d+)?\s*x\s",
                )
                self.assertTrue(rule["eligibility"])

    def test_business_momentum_boundaries(self):
        cases = [
            (8, "Momentum is strong."),
            (7.9, "The business is growing."),
            (2, "The business is growing."),
            (1.9, "The business is steady."),
            (-1.9, "The business is steady."),
            (-2, "Momentum has softened."),
            (-7.9, "Momentum has softened."),
            (-8, "The business is cooling."),
        ]
        for value, label in cases:
            with self.subTest(value=value):
                self.assertEqual(business_momentum(value)["label"], label)
        self.assertFalse(business_momentum(None)["eligible"])

    def test_today_low_signal_and_direction_boundaries(self):
        self.assertEqual(today_pace(True, 0, 100, "Friday")["label"], "Too early to call today")
        self.assertEqual(today_pace(True, 2, 100, "Friday")["label"], "Today is still low-signal")
        self.assertFalse(today_pace(True, 2, 100, "Friday")["eligible"])
        self.assertEqual(today_pace(True, 3, 15, "Friday")["label"], "Ahead of a typical Friday")
        self.assertEqual(today_pace(False, 0, -15, "Friday")["label"], "Behind a typical Friday")
        self.assertEqual(today_pace(True, 3, 14.9, "Friday")["label"], "Tracking near a typical Friday")
        self.assertFalse(today_pace(False, 4, None, "Friday")["eligible"])

    def test_today_business_context_boundaries(self):
        self.assertEqual(today_business_context(5, 6)["label"], "Positive momentum")
        self.assertEqual(today_business_context(-5, -6)["label"], "Negative momentum")
        self.assertEqual(today_business_context(5, -5)["label"], "Mixed momentum")
        self.assertEqual(today_business_context(4.9, -4.9)["label"], "Mostly flat")
        self.assertFalse(today_business_context(None, None)["eligible"])

    def test_sales_rule_boundaries(self):
        self.assertEqual(sales_product_change(0.01)["label"], "Improving")
        self.assertEqual(sales_product_change(0)["label"], "Flat")
        self.assertEqual(sales_product_change(-0.01)["label"], "Weakening")
        self.assertEqual(sales_concentration(55)["label"], "Broad")
        self.assertEqual(sales_concentration(55.1)["label"], "Balanced")
        self.assertEqual(sales_concentration(74.9)["label"], "Balanced")
        self.assertEqual(sales_concentration(75)["label"], "Concentrated")
        self.assertEqual(sales_breadth(3, 1, 1)["label"], "Broad improvement")
        self.assertEqual(sales_breadth(1, 3, 1)["label"], "Broad weakening")
        self.assertEqual(sales_breadth(2, 1, 1)["label"], "Mixed movement")

    @staticmethod
    def offer(**overrides):
        row = {
            "sku": "NEW",
            "product_role": "SELLABLE_STANDALONE",
            "catalog_membership": "CURRENT_OFFER",
            "status": "Active",
            "open_date": date(2026, 7, 31),
            "inventory_action": "WATCH",
            "sessions_t28": 0,
            "conversion_t28_pct": None,
            "sales_t28": 0,
            "units_t28": 0,
            "sales_delta28_pct": 0,
        }
        row.update(overrides)
        return row

    def test_catalog_requires_full_window_before_demand_label(self):
        cutoff = date(2026, 8, 27)
        self.assertEqual(eligible_exposure_days(date(2026, 8, 1), cutoff), 27)
        self.assertEqual(eligible_exposure_days(date(2026, 7, 31), cutoff), 28)
        state, _, evaluation = catalog_offer_state(
            self.offer(open_date=date(2026, 8, 1)), 100, 2, cutoff
        )
        self.assertEqual(state, "LEARNING")
        self.assertFalse(evaluation["eligible"])
        self.assertEqual(evaluation["inputs"]["eligible_exposure_days"], 27)
        self.assertEqual(catalog_offer_state(self.offer(), 100, 2, cutoff)[0], "DORMANT")

    def test_catalog_inventory_fact_precedes_exposure_eligibility(self):
        state, _, evaluation = catalog_offer_state(
            self.offer(open_date=date(2026, 8, 27), inventory_action="STOCKOUT"),
            100,
            2,
            date(2026, 8, 27),
        )
        self.assertEqual(state, "INVENTORY_RISK")
        self.assertTrue(evaluation["eligible"])

    def test_catalog_funnel_and_movement_boundaries(self):
        cutoff = date(2026, 8, 27)
        traffic = self.offer(sessions_t28=115, conversion_t28_pct=1.43, sales_t28=100, units_t28=1)
        self.assertEqual(catalog_offer_state(traffic, 100, 2, cutoff)[0], "TRAFFIC_NOT_CONVERTING")
        self.assertNotEqual(
            catalog_offer_state({**traffic, "conversion_t28_pct": 1.44}, 100, 2, cutoff)[0],
            "TRAFFIC_NOT_CONVERTING",
        )
        converts = self.offer(sessions_t28=65, conversion_t28_pct=2.51, sales_t28=100, units_t28=2)
        self.assertEqual(catalog_offer_state(converts, 100, 2, cutoff)[0], "CONVERTS_NEEDS_TRAFFIC")
        self.assertNotEqual(
            catalog_offer_state({**converts, "conversion_t28_pct": 2.5}, 100, 2, cutoff)[0],
            "CONVERTS_NEEDS_TRAFFIC",
        )
        self.assertEqual(
            catalog_offer_state(self.offer(sessions_t28=100, sales_t28=100, units_t28=1, sales_delta28_pct=20), 100, 2, cutoff)[0],
            "ACCELERATING",
        )
        self.assertEqual(
            catalog_offer_state(self.offer(sessions_t28=100, sales_t28=100, units_t28=1, sales_delta28_pct=-20), 100, 2, cutoff)[0],
            "DECLINING",
        )

    def test_catalog_dimension_boundaries(self):
        self.assertEqual(catalog_dimension_conversion(2.4, 2)["label"], "Converts above portfolio")
        self.assertEqual(catalog_dimension_conversion(1.6, 2)["label"], "Converts below portfolio")
        self.assertEqual(catalog_dimension_conversion(2, 2)["label"], "Near portfolio conversion")

    def test_trajectory_boundaries_are_exact(self):
        def rows(d7, d28, d56, d90):
            return [
                {"label": "7D", "delta_pct": d7},
                {"label": "28D", "delta_pct": d28},
                {"label": "56D", "delta_pct": d56},
                {"label": "90D", "delta_pct": d90},
            ]

        self.assertEqual(
            trajectory_structure(rows(0, 5.1, 2.1, 2.1))["label"],
            "Momentum is structurally stronger.",
        )
        self.assertNotEqual(
            trajectory_structure(rows(0, 5, 2.1, 2.1))["label"],
            "Momentum is structurally stronger.",
        )
        self.assertEqual(
            trajectory_structure(rows(5.1, 1.9, 0, 0))["label"],
            "Short-term acceleration, not yet structural.",
        )
        self.assertFalse(trajectory_structure(rows(None, 1, 1, 1))["eligible"])


if __name__ == "__main__":
    unittest.main()
