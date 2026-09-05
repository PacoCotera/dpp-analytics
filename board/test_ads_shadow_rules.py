from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import unittest

from ads_shadow_rules import (
    data_blocker_candidate,
    evaluate_product_shadow_candidates,
    inventory_conflict_candidate,
    product_conversion_gap_candidate,
)


NOW = datetime(2026, 9, 5, 1, 0, tzinfo=timezone.utc)
WINDOW = {
    "id": "ADS_FINALIZED_T28",
    "start": "2026-08-06",
    "through": "2026-09-02",
    "state": "RECONCILED",
    "cutoff": "2026-09-03T06:00:00Z",
    "currency": "MXN",
}


def product(**overrides) -> dict:
    values = {
        "marketplace_id": "A1AM78C64UM0Y8",
        "sku": "PNC-001",
        "asin": "B012345678",
        "product": "Pocket notebook",
        "is_offer_owner": True,
        "catalog_membership": "CURRENT_OFFER",
        "status": "Active",
        "inventory_action": "PRODUCE",
        "available": 4,
        "inbound": 10,
        "days_cover_with_inbound": 12,
        "spend": 120,
        "clicks": 12,
        "attributed_purchases": 0,
        "observed_ads_days": 28,
        "mature_ads_days": 21,
        "attribution_lookback_days": 7,
        "ads_trusted": True,
        "sessions_t28": 40,
    }
    values.update(overrides)
    return values


class AdvertisingShadowRuleTests(unittest.TestCase):
    def test_untrusted_source_creates_blocker_but_healthy_source_does_not(self):
        source = {
            "marketplace_id": "A1AM78C64UM0Y8",
            "source_key": "amazon_ads",
            "label": "Amazon Ads",
            "trusted": False,
            "state": "RECONCILIATION_FAILED",
            "reason": "Campaign and advertised-product spend differ.",
        }
        candidate = data_blocker_candidate(source, WINDOW, now=NOW)
        self.assertEqual(candidate["kind"], "ADS_DATA_BLOCKER")
        self.assertEqual(candidate["suppression"]["resolution"], "BLOCK_DOMAIN")
        self.assertEqual(candidate["materiality"]["amount"], 0)
        self.assertIn("no monetary impact is claimed", candidate["materiality"]["basis"])
        source["trusted"] = True
        self.assertIsNone(data_blocker_candidate(source, WINDOW, now=NOW))

    def test_inventory_conflict_is_observed_exposure_not_a_pause_instruction(self):
        candidate = inventory_conflict_candidate(product(), WINDOW, now=NOW)
        self.assertEqual(candidate["kind"], "ADS_INVENTORY_CONFLICT")
        self.assertEqual(candidate["materiality"]["amount"], 120)
        self.assertEqual(candidate["materiality"]["type"], "OBSERVED_EXPOSURE")
        self.assertEqual(candidate["recommendation"]["action_class"], "INVESTIGATE")
        self.assertNotIn("pause", candidate["recommendation"]["title"].lower())
        self.assertIsNone(candidate["suppression"])

    def test_inventory_conflict_is_suppressed_when_source_or_owner_is_unsafe(self):
        candidate = inventory_conflict_candidate(
            product(ads_trusted=False, is_offer_owner=False, catalog_membership="CURRENT_ALIAS"),
            WINDOW,
            now=NOW,
        )
        self.assertEqual(candidate["suppression"]["resolution"], "BLOCK_DOMAIN")
        self.assertEqual({item["domain"] for item in candidate["blockers"]}, {"ADVERTISING", "PRODUCT"})
        self.assertEqual(candidate["confidence"]["band"], "LOW")

    def test_non_constrained_or_unsupported_product_creates_no_inventory_candidate(self):
        self.assertIsNone(inventory_conflict_candidate(product(inventory_action="HOLD"), WINDOW, now=NOW))
        self.assertIsNone(inventory_conflict_candidate(product(spend=0), WINDOW, now=NOW))
        self.assertIsNone(inventory_conflict_candidate(product(spend=float("nan")), WINDOW, now=NOW))
        self.assertIsNone(inventory_conflict_candidate(product(spend=float("inf")), WINDOW, now=NOW))

    def test_inventory_candidate_is_suppressed_without_enough_observed_days(self):
        candidate = inventory_conflict_candidate(
            product(observed_ads_days=13, mature_ads_days=13), WINDOW, now=NOW
        )
        self.assertEqual(candidate["suppression"]["code"], "INSUFFICIENT_OBSERVED_DAYS")

    def test_conversion_gap_requires_exact_boundaries_and_product_context(self):
        candidate = product_conversion_gap_candidate(product(clicks=8), WINDOW, now=NOW)
        self.assertEqual(candidate["kind"], "ADS_PRODUCT_CONVERSION_GAP")
        facts = {item["fact"] for item in candidate["evidence"]}
        self.assertIn("product.sessions", facts)
        self.assertIn("product.listing_status", facts)
        self.assertIn("not incrementality", candidate["evidence"][1]["basis"])
        self.assertIsNone(product_conversion_gap_candidate(product(clicks=7), WINDOW, now=NOW))
        self.assertIsNone(product_conversion_gap_candidate(product(attributed_purchases=1), WINDOW, now=NOW))

    def test_immature_conversion_gap_is_recorded_but_suppressed(self):
        candidate = product_conversion_gap_candidate(
            product(observed_ads_days=14, mature_ads_days=6), WINDOW, now=NOW
        )
        self.assertEqual(candidate["suppression"]["code"], "ATTRIBUTION_IMMATURE")
        self.assertEqual(candidate["recommendation"]["execution_state"], "SHADOW_ONLY")

    def test_missing_product_context_is_recorded_but_suppressed(self):
        candidate = product_conversion_gap_candidate(
            product(sessions_t28=None, status=None), WINDOW, now=NOW
        )
        self.assertEqual(candidate["suppression"]["code"], "PRODUCT_CONTEXT_MISSING")

    def test_multi_rule_evaluation_is_deterministic(self):
        rows = [product(sku="B", asin="B000000002"), product(sku="A", asin="B000000001")]
        first = evaluate_product_shadow_candidates(rows, WINDOW, now=NOW)
        second = evaluate_product_shadow_candidates(deepcopy(rows), WINDOW, now=NOW)
        self.assertEqual(first, second)
        self.assertEqual(len(first), 4)


if __name__ == "__main__":
    unittest.main()
