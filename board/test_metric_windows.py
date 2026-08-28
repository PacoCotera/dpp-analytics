from __future__ import annotations

import unittest
from datetime import date, datetime, timezone

from metric_windows import (
    CONTRACTS,
    INVENTORY_ORDER_VELOCITY_T28,
    RECONCILED_BUSINESS_T28,
    RECONCILED_PRODUCT_T28,
    build_metric_window,
    metric_window_fingerprint,
)


class MetricWindowContractTests(unittest.TestCase):
    def setUp(self):
        self.source_as_of = datetime(2026, 8, 27, 3, 15, tzinfo=timezone.utc)

    def window(self, contract_id, through=date(2026, 8, 26), as_of=None):
        return build_metric_window(
            contract_id,
            through,
            self.source_as_of if as_of is None else as_of,
            "America/Mexico_City",
        )

    def test_28_day_window_is_inclusive(self):
        window = self.window(RECONCILED_BUSINESS_T28)

        self.assertEqual(window["start_date"], date(2026, 7, 30))
        self.assertEqual(window["through_date"], date(2026, 8, 26))
        self.assertEqual((window["through_date"] - window["start_date"]).days + 1, 28)
        self.assertEqual(window["included_days"], 28)

    def test_every_contract_discloses_required_basis(self):
        for contract_id in CONTRACTS:
            with self.subTest(contract_id=contract_id):
                window = self.window(contract_id)
                for field in (
                    "id",
                    "label",
                    "source_id",
                    "source",
                    "grain",
                    "definition",
                    "start_date",
                    "through_date",
                    "source_as_of",
                    "timezone",
                ):
                    self.assertTrue(window.get(field), field)

    def test_shared_contracts_have_stable_cross_page_fingerprint(self):
        sales = self.window(RECONCILED_PRODUCT_T28)
        catalog = self.window(RECONCILED_PRODUCT_T28)
        product = self.window(RECONCILED_PRODUCT_T28)

        self.assertEqual(metric_window_fingerprint(sales), metric_window_fingerprint(catalog))
        self.assertEqual(metric_window_fingerprint(catalog), metric_window_fingerprint(product))

    def test_distinct_semantics_have_distinct_ids_sources_and_grains(self):
        reconciled = self.window(RECONCILED_PRODUCT_T28)
        inventory = self.window(INVENTORY_ORDER_VELOCITY_T28)

        self.assertNotEqual(reconciled["id"], inventory["id"])
        self.assertNotEqual(reconciled["source_id"], inventory["source_id"])
        self.assertNotEqual(reconciled["grain"], inventory["grain"])

    def test_unavailable_cutoff_remains_explicit(self):
        window = self.window(RECONCILED_BUSINESS_T28, through=None)

        self.assertIsNone(window["start_date"])
        self.assertIsNone(window["through_date"])
        self.assertEqual(window["source_as_of"], self.source_as_of)

    def test_zero_length_window_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "must be positive"):
            build_metric_window(
                RECONCILED_BUSINESS_T28,
                date(2026, 8, 26),
                self.source_as_of,
                "America/Mexico_City",
                days=0,
            )


if __name__ == "__main__":
    unittest.main()
