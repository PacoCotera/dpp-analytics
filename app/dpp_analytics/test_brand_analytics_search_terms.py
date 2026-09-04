from __future__ import annotations

import unittest
from datetime import date
from decimal import Decimal
from unittest.mock import MagicMock

from .brand_analytics_search_terms import (
    REPORT_TYPE,
    RETENTION_BASIS,
    _create_report,
    _row_values,
    report_rows,
    select_relevant_rows,
    validate_report_payload,
)
from .settings import settings
from .spapi import SpApiError


class BrandAnalyticsSearchTermsTests(unittest.TestCase):
    def test_create_report_uses_exact_week_without_asin_filter(self) -> None:
        client = MagicMock()
        client.post.return_value = {"payload": {"reportId": "terms-1"}}

        result = _create_report(client, date(2026, 8, 23), date(2026, 8, 29))

        self.assertEqual(result, "terms-1")
        body = client.post.call_args.kwargs["json_body"]
        self.assertEqual(body["reportType"], REPORT_TYPE)
        self.assertEqual(body["marketplaceIds"], [settings.marketplace_id])
        self.assertEqual(body["reportOptions"], {"reportPeriod": "WEEK"})
        self.assertNotIn("asin", body["reportOptions"])
        self.assertNotIn("asins", body["reportOptions"])

    def test_report_rows_accepts_direct_and_wrapped_payloads(self) -> None:
        rows = [{"searchTerm": "dog mom"}]
        self.assertEqual(report_rows({"dataByDepartmentAndSearchTerm": rows}), rows)
        self.assertEqual(
            report_rows({"payload": {"dataByDepartmentAndSearchTerm": rows}}), rows
        )

    def test_row_mapping_preserves_market_query_and_clicked_product_context(self) -> None:
        row = {
            "departmentName": "Pet Supplies",
            "searchTerm": " Dog  Mom ",
            "searchFrequencyRank": 12,
            "clickedAsin": "B000000001",
            "clickedItemName": "A very useful product name",
            "clickShareRank": 1,
            "clickShare": 0.42,
            "conversionShare": 0.31,
        }

        columns, values = _row_values(
            row, date(2026, 8, 23), date(2026, 8, 29), 123, "terms-1"
        )
        mapped = dict(zip(columns, values, strict=True))

        self.assertEqual(mapped["search_term"], "Dog  Mom")
        self.assertEqual(mapped["search_term_key"], "dog mom")
        self.assertEqual(mapped["clicked_item_name"], "A very useful product name")
        self.assertEqual(mapped["click_share"], Decimal("0.42"))
        self.assertEqual(mapped["conversion_share"], Decimal("0.31"))
        self.assertFalse(mapped["matches_owned_clicked_asin"])
        self.assertFalse(mapped["matches_tracked_query"])

    def test_selection_retains_owned_products_and_observed_dpp_queries(self) -> None:
        payload = {
            "reportSpecification": {
                "reportType": REPORT_TYPE,
                "dataStartTime": "2026-08-23",
                "dataEndTime": "2026-08-29",
                "marketplaceIds": [settings.marketplace_id],
                "reportOptions": {"reportPeriod": "WEEK"},
            },
            "dataByDepartmentAndSearchTerm": [
                {
                    "departmentName": "Office",
                    "searchTerm": "notebook",
                    "clickedAsin": "OWNED-ASIN",
                },
                {
                    "departmentName": "Office",
                    "searchTerm": " Pocket   notebook ",
                    "clickedAsin": "COMPETITOR-ASIN",
                },
                {
                    "departmentName": "Electronics",
                    "searchTerm": "phone",
                    "clickedAsin": "UNRELATED-ASIN",
                },
            ],
        }

        retained, stats = select_relevant_rows(
            payload,
            date(2026, 8, 23),
            date(2026, 8, 29),
            {"OWNED-ASIN"},
            {"pocket notebook"},
        )

        self.assertEqual(RETENTION_BASIS, "OWNED_CLICKED_ASIN_OR_OBSERVED_DPP_QUERY")
        self.assertEqual([row["clickedAsin"] for row in retained], [
            "OWNED-ASIN", "COMPETITOR-ASIN"
        ])
        self.assertEqual(stats, {
            "source_rows": 3,
            "retained_rows": 2,
            "owned_clicked_rows": 1,
            "tracked_query_rows": 1,
        })
        self.assertTrue(retained[0]["_matchesOwnedClickedAsin"])
        self.assertTrue(retained[1]["_matchesTrackedQuery"])

    def test_reconciliation_requires_exact_report_specification(self) -> None:
        payload = {
            "reportSpecification": {
                "reportType": REPORT_TYPE,
                "dataStartTime": "2026-08-23T00:00:00Z",
                "dataEndTime": "2026-08-29T23:59:59Z",
                "marketplaceIds": [settings.marketplace_id],
                "reportOptions": {"reportPeriod": "WEEK"},
            },
            "dataByDepartmentAndSearchTerm": [{
                "departmentName": "Pet Supplies",
                "searchTerm": "dog mom",
                "clickedAsin": "B000000001",
            }],
        }
        self.assertEqual(
            len(validate_report_payload(payload, date(2026, 8, 23), date(2026, 8, 29))),
            1,
        )
        payload["reportSpecification"]["dataEndTime"] = "2026-08-30T23:59:59Z"
        with self.assertRaisesRegex(SpApiError, "requested period grain"):
            validate_report_payload(payload, date(2026, 8, 23), date(2026, 8, 29))

    def test_reconciliation_rejects_incomplete_or_duplicate_identity(self) -> None:
        payload = {
            "reportSpecification": {
                "reportType": REPORT_TYPE,
                "dataStartTime": "2026-08-23",
                "dataEndTime": "2026-08-29",
                "marketplaceIds": [settings.marketplace_id],
                "reportOptions": {"reportPeriod": "WEEK"},
            },
            "dataByDepartmentAndSearchTerm": [{
                "departmentName": "Pet Supplies",
                "searchTerm": "dog mom",
                "clickedAsin": "",
            }],
        }
        with self.assertRaisesRegex(SpApiError, "incomplete identity"):
            validate_report_payload(payload, date(2026, 8, 23), date(2026, 8, 29))


if __name__ == "__main__":
    unittest.main()
