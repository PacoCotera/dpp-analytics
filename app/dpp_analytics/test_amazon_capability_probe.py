from __future__ import annotations

import datetime as dt
import unittest
from unittest.mock import patch

from .amazon_capability_probe import (
    ADS_REPORT_CONFIGS,
    CAPABILITIES,
    REPORT_SPECS,
    ReportSpec,
    _safe_error,
    field_paths,
    last_completed_week,
    render_markdown,
    report_request_body,
    summarize_payload,
)


class AmazonCapabilityManifestTests(unittest.TestCase):
    def test_capability_keys_are_unique_and_every_live_report_is_documented(
        self,
    ) -> None:
        keys = [item.key for item in CAPABILITIES]
        self.assertEqual(len(keys), len(set(keys)))
        self.assertTrue({item.key for item in REPORT_SPECS}.issubset(set(keys)))
        self.assertTrue(set(ADS_REPORT_CONFIGS).issubset(set(keys)))

    def test_search_term_retention_and_accounting_authority_are_explicit(self) -> None:
        by_key = {item.key: item for item in CAPABILITIES}
        self.assertEqual(
            by_key["ads_search_term_extended"].retention, "65 days at source"
        )
        self.assertIn("never actual", by_key["fba_fee_preview"].authority)
        self.assertIn("not incremental", by_key["ads_purchased_product"].authority)

    def test_ads_configs_cover_halo_placement_and_safety_context(self) -> None:
        purchased = ADS_REPORT_CONFIGS["ads_purchased_product"]["columns"]
        placement = ADS_REPORT_CONFIGS["ads_placement"]["columns"]
        target = ADS_REPORT_CONFIGS["ads_target_extended"]["columns"]
        self.assertIn("purchasedAsin", purchased)
        self.assertIn("salesOtherSku7d", purchased)
        self.assertIn("placementClassification", placement)
        self.assertIn("campaignBiddingStrategy", placement)
        self.assertIn("keywordBid", target)
        self.assertIn("adKeywordStatus", target)


class AmazonCapabilityProbeHelpersTests(unittest.TestCase):
    def test_field_paths_return_shape_without_values(self) -> None:
        paths = field_paths(
            {"orders": [{"orderId": "123", "items": [{"asin": "B012345678"}]}]}
        )
        self.assertEqual(
            paths, ["orders", "orders.items", "orders.items.asin", "orders.orderId"]
        )
        self.assertNotIn("B012345678", " ".join(paths))

    def test_summarize_payload_finds_nested_rows(self) -> None:
        summary = summarize_payload({"payload": {"responses": [{"status": 200}]}})
        self.assertEqual(summary["sample_count"], 1)
        self.assertTrue(summary["populated"])

    def test_safe_error_removes_customer_and_vendor_identifiers(self) -> None:
        message = _safe_error(
            'Atza|secret 123-1234567-1234567 B012345678 123456789012345 "Campaign Secret"'
        )
        self.assertNotIn("secret", message)
        self.assertNotIn("B012345678", message)
        self.assertNotIn("123456789012345", message)
        self.assertNotIn("Campaign Secret", message)

    def test_last_completed_week_is_sunday_through_saturday(self) -> None:
        start, end = last_completed_week(dt.date(2026, 9, 4))
        self.assertEqual(start, dt.date(2026, 8, 23))
        self.assertEqual(end, dt.date(2026, 8, 29))
        self.assertEqual(start.weekday(), 6)
        self.assertEqual(end.weekday(), 5)

    @patch("dpp_analytics.amazon_capability_probe.settings")
    def test_brand_report_request_has_exact_completed_period_and_asin(
        self, fake_settings
    ) -> None:
        fake_settings.marketplace_id = "MARKET"
        spec = ReportSpec("sqp", "REPORT", "last_week", "WEEK", "asin")
        body = report_request_body(spec, "ASIN", dt.date(2026, 9, 4))
        self.assertEqual(body["marketplaceIds"], ["MARKET"])
        self.assertEqual(body["dataStartTime"], "2026-08-23T00:00:00Z")
        self.assertEqual(body["dataEndTime"], "2026-08-29T23:59:59Z")
        self.assertEqual(
            body["reportOptions"], {"reportPeriod": "WEEK", "asin": "ASIN"}
        )

    def test_markdown_contains_states_but_no_payload_values(self) -> None:
        result = {
            "generated_at": "2026-09-04T00:00:00Z",
            "git_sha": "abc",
            "marketplace": "MARKET",
            "capabilities": [
                {
                    "domain": "Advertising",
                    "source": "Source",
                    "decision_use": "Decide",
                    "initial_disposition": "ingest now",
                    "production_evidence": {
                        "state": "authorized_populated",
                        "sample_count": 2,
                        "secret": "do not render",
                    },
                }
            ],
        }
        text = render_markdown(result)
        self.assertIn("authorized_populated", text)
        self.assertNotIn("do not render", text)


if __name__ == "__main__":
    unittest.main()
