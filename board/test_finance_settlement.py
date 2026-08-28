from __future__ import annotations

import itertools
import unittest

from finance_settlement import settlement_display_contract


class FinanceSettlementDisplayTest(unittest.TestCase):
    def test_every_null_date_combination_is_explicit_and_keeps_identifiers(self):
        known = "2026-08-15"
        for start, end, deposit in itertools.product((None, known), repeat=3):
            with self.subTest(start=start, end=end, deposit=deposit):
                result = settlement_display_contract(
                    "27148998881",
                    "66913020679",
                    start,
                    end,
                    deposit,
                )
                expected_known = sum(value is not None for value in (start, end, deposit))
                expected_state = (
                    "UNKNOWN" if expected_known == 0 else "KNOWN" if expected_known == 3 else "PARTIAL"
                )
                self.assertEqual(result["date_state"], expected_state)
                self.assertEqual(result["identity_label"], "Settlement 27148998881 · report 66913020679")
                self.assertNotIn("—", result["period_label"])
                self.assertNotIn("—", result["deposit_label"])

    def test_all_unknown_dates_have_explicit_unknown_labels(self):
        result = settlement_display_contract("27148998881", "66913020679", None, None, None)
        self.assertEqual(result["date_state"], "UNKNOWN")
        self.assertEqual(result["period_state"], "UNKNOWN")
        self.assertEqual(result["period_label"], "Settlement dates unknown")
        self.assertEqual(result["deposit_state"], "UNKNOWN")
        self.assertEqual(result["deposit_label"], "Deposit date unknown")

    def test_partial_period_names_exact_missing_boundary(self):
        start_only = settlement_display_contract("s", "r", "2026-08-01", None, "2026-08-18")
        end_only = settlement_display_contract("s", "r", None, "2026-08-15", "2026-08-18")
        self.assertEqual(start_only["period_label"], "Settlement from Aug 1 · end date unknown")
        self.assertEqual(end_only["period_label"], "Settlement through Aug 15 · start date unknown")


if __name__ == "__main__":
    unittest.main()
