from __future__ import annotations

import unittest
from decimal import Decimal
from unittest.mock import MagicMock

from .finances import _identifier_rows, _item_rows, _replace_transaction_children


class FinanceItemNormalizationTests(unittest.TestCase):
    def test_item_rows_preserve_source_order_and_recursive_evidence(self) -> None:
        transaction = {
            "items": [
                {
                    "description": "Extreme product name " + ("x" * 200),
                    "totalAmount": {
                        "currencyAmount": "-1234567.8901",
                        "currencyCode": "MXN",
                    },
                    "contexts": [
                        {
                            "contextType": "Shipment",
                            "sku": "SKU-1",
                            "asin": "B000000001",
                            "quantityShipped": 2,
                        }
                    ],
                    "relatedIdentifiers": [
                        {
                            "itemRelatedIdentifierName": "ORDER_ID",
                            "itemRelatedIdentifierValue": "order-1",
                        }
                    ],
                    "breakdowns": [
                        {
                            "breakdownType": "Fees",
                            "breakdowns": [{"breakdownType": "Commission"}],
                        }
                    ],
                },
                {"totalAmount": {"amount": 0, "currencyCode": "MXN"}},
            ]
        }

        rows = _item_rows(transaction)

        self.assertEqual([row["item_ordinal"] for row in rows], [1, 2])
        self.assertEqual(rows[0]["total_amount"], Decimal("-1234567.8901"))
        self.assertEqual(rows[0]["contexts"][0]["asin"], "B000000001")
        self.assertEqual(
            rows[0]["breakdowns"][0]["breakdowns"][0]["breakdownType"],
            "Commission",
        )
        self.assertEqual(rows[1]["total_amount"], Decimal("0"))

    def test_identifier_rows_keep_nested_and_competing_values(self) -> None:
        identifiers = [
            {
                "relatedIdentifierName": "ORDER_ID",
                "relatedIdentifierValue": "order-1",
            },
            {
                "nested": [
                    {
                        "itemRelatedIdentifierName": "ASIN",
                        "itemRelatedIdentifierValue": "B000000001",
                    },
                    {
                        "itemRelatedIdentifierName": "ASIN",
                        "itemRelatedIdentifierValue": "B000000002",
                    },
                ]
            },
        ]

        self.assertEqual(
            _identifier_rows(identifiers),
            [
                (1, "ORDER_ID", "order-1"),
                (2, "ASIN", "B000000001"),
                (3, "ASIN", "B000000002"),
            ],
        )

    def test_non_list_items_degrade_to_no_normalized_items(self) -> None:
        self.assertEqual(_item_rows({"items": None}), [])
        self.assertEqual(_item_rows({"items": {"asin": "B000000001"}}), [])

    def test_replacement_deletes_stale_children_before_inserts(self) -> None:
        cursor = MagicMock()
        transaction = {
            "relatedIdentifiers": [
                {
                    "relatedIdentifierName": "ORDER_ID",
                    "relatedIdentifierValue": "order-1",
                }
            ],
            "items": [
                {
                    "contexts": [
                        {"sku": "SKU-1", "asin": "B000000001"},
                        {"sku": "SKU-2", "asin": "B000000002"},
                    ],
                    "relatedIdentifiers": [
                        {
                            "itemRelatedIdentifierName": "ASIN",
                            "itemRelatedIdentifierValue": "B000000001",
                        }
                    ],
                }
            ],
        }

        _replace_transaction_children(cursor, "tx-1", transaction, 99)

        statements = [call.args[0] for call in cursor.execute.call_args_list]
        self.assertIn(
            "DELETE FROM core.financial_transaction_identifier WHERE transaction_id=%s",
            statements[0],
        )
        self.assertIn(
            "DELETE FROM core.financial_transaction_item WHERE transaction_id=%s",
            statements[2],
        )
        self.assertEqual(
            sum("financial_transaction_item_context" in sql for sql in statements), 2
        )
        self.assertEqual(
            sum("financial_transaction_item_identifier" in sql for sql in statements), 1
        )


if __name__ == "__main__":
    unittest.main()
