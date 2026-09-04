from __future__ import annotations

import unittest

from .production_probe import _finance_item_evidence


class _Cursor:
    def __init__(self) -> None:
        self.query_number = 0

    def execute(self, _sql: str) -> None:
        self.query_number += 1

    def fetchone(self):
        if self.query_number == 1:
            return {
                "current_transactions": 10,
                "raw_transactions_with_items": 8,
                "raw_item_rows": 12,
                "normalized_item_rows": 12,
                "normalized_transactions_with_items": 8,
            }
        return {
            "context_rows": 13,
            "contexts_with_sku": 11,
            "contexts_with_asin": 11,
            "contexts_with_sku_and_asin": 10,
            "transaction_identifier_rows": 20,
            "item_identifier_rows": 18,
            "item_breakdown_rows": 40,
            "item_leaf_breakdown_rows": 30,
        }

    def fetchall(self):
        return [
            {"identity_state": "CONFLICT", "item_count": 1},
            {"identity_state": "EXACT", "item_count": 10},
            {"identity_state": "MISSING", "item_count": 1},
        ]


class FinanceItemProductionEvidenceTests(unittest.TestCase):
    def test_reports_backfill_parity_and_conservative_identity_states(self) -> None:
        result = _finance_item_evidence(_Cursor())

        self.assertTrue(result["backfill_complete"])
        self.assertEqual(result["raw_normalized_item_delta"], 0)
        self.assertEqual(result["identity_states"]["EXACT"], 10)
        self.assertEqual(result["identity_states"]["CONFLICT"], 1)
        self.assertEqual(result["contexts_with_sku_and_asin"], 10)
        self.assertEqual(result["item_leaf_breakdown_rows"], 30)


if __name__ == "__main__":
    unittest.main()
