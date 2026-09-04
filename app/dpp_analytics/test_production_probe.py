from __future__ import annotations

import unittest
from decimal import Decimal

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
        if self.query_number == 3:
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
        if self.query_number == 9:
            return {
                "exact_items": 10,
                "current_offer_items": 9,
                "current_owner_items": 8,
                "historical_or_unmapped_items": 1,
                "exact_item_amount": 90,
                "current_offer_amount": 85,
                "current_owner_amount": 80,
                "historical_or_unmapped_amount": 5,
            }
        raise AssertionError(f"unexpected fetchone for query {self.query_number}")

    def fetchall(self):
        if self.query_number == 2:
            return [
                {"identity_state": "CONFLICT", "item_count": 1},
                {"identity_state": "EXACT", "item_count": 10},
                {"identity_state": "MISSING", "item_count": 1},
            ]
        if self.query_number == 4:
            return [
                {
                    "transaction_type": "Shipment",
                    "transactions": 8,
                    "transactions_with_item_total": 8,
                    "transactions_with_item_leaf": 8,
                    "transactions_with_transaction_leaf": 8,
                    "item_total_matches": 8,
                    "item_leaf_matches": 0,
                    "transaction_leaf_matches": 8,
                    "transaction_total": 100,
                    "item_total": 100,
                    "item_leaf_total": 90,
                    "transaction_leaf_total": 100,
                    "item_total_delta": 0,
                    "item_leaf_delta": 10,
                    "transaction_leaf_delta": 0,
                    "max_abs_item_total_delta": 0,
                    "max_abs_item_leaf_delta": 5,
                    "max_abs_transaction_leaf_delta": 0,
                }
            ]
        if self.query_number == 5:
            return [
                {
                    "transaction_type": "Shipment",
                    "breakdown_path": "Sales > Principal",
                    "currency": "MXN",
                    "rows": 8,
                    "amount": 100,
                }
            ]
        if self.query_number == 6:
            return [
                {
                    "source_level": "ITEM",
                    "identifier_name": "ORDER_ID",
                    "rows": 8,
                }
            ]
        if self.query_number == 7:
            return [
                {
                    "transaction_type": "Shipment",
                    "transactions": 8,
                    "transactions_with_items": 8,
                    "item_rows": 12,
                    "exact_identity_items": 10,
                    "unresolved_identity_items": 2,
                    "transaction_total": 100,
                    "item_total": 100,
                    "transaction_without_item_amount": 0,
                    "exact_identity_item_amount": 90,
                    "unresolved_identity_item_amount": 10,
                    "product_allocation_residual": 10,
                }
            ]
        if self.query_number == 8:
            return [
                {
                    "transaction_type": "Shipment",
                    "breakdown_path": "Sales > Principal",
                    "identity_state": "MISSING",
                    "currency": "MXN",
                    "rows": 2,
                    "amount": 10,
                }
            ]
        raise AssertionError(f"unexpected fetchall for query {self.query_number}")


class FinanceItemProductionEvidenceTests(unittest.TestCase):
    def test_reports_backfill_parity_and_conservative_identity_states(self) -> None:
        result = _finance_item_evidence(_Cursor())

        self.assertTrue(result["backfill_complete"])
        self.assertEqual(result["raw_normalized_item_delta"], 0)
        self.assertEqual(result["identity_states"]["EXACT"], 10)
        self.assertEqual(result["identity_states"]["CONFLICT"], 1)
        self.assertEqual(result["contexts_with_sku_and_asin"], 10)
        self.assertEqual(result["item_leaf_breakdown_rows"], 30)
        self.assertEqual(
            result["reconciliation_candidates"][0]["item_total_matches"], 8
        )
        self.assertEqual(
            result["leaf_breakdown_categories"][0]["breakdown_path"],
            "Sales > Principal",
        )
        self.assertEqual(
            result["identifier_categories"][0]["identifier_name"], "ORDER_ID"
        )
        allocation = result["product_allocation_by_transaction_type"][0]
        self.assertEqual(allocation["exact_identity_item_amount"], "90")
        self.assertEqual(allocation["product_allocation_residual"], "10")
        self.assertEqual(
            Decimal(allocation["transaction_total"]),
            Decimal(allocation["exact_identity_item_amount"])
            + Decimal(allocation["product_allocation_residual"]),
        )
        self.assertEqual(
            Decimal(allocation["item_total"]),
            Decimal(allocation["exact_identity_item_amount"])
            + Decimal(allocation["unresolved_identity_item_amount"]),
        )
        self.assertEqual(
            result["product_breakdown_identity"][0]["identity_state"], "MISSING"
        )
        self.assertEqual(result["current_catalog_identity"]["current_owner_items"], 8)
        self.assertEqual(
            result["current_catalog_identity"]["historical_or_unmapped_amount"],
            "5",
        )


if __name__ == "__main__":
    unittest.main()
