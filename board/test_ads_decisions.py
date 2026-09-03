from __future__ import annotations

import unittest

from ads_decisions import (
    ECONOMICS_CONTRACT,
    INTERPRETATION_RULES,
    build_action_groups,
    demand_page,
    enrich_products,
    metric_contract,
    normalize_demand_signal,
    safe_ratio,
)


class AdsDecisionContractTests(unittest.TestCase):
    def test_ratios_require_a_valid_denominator(self):
        self.assertIsNone(safe_ratio(10, 0))
        self.assertIsNone(safe_ratio(10, None))
        self.assertEqual(safe_ratio(0, 10), 0)
        row = metric_contract(
            {
                "spend": 10,
                "attributed_sales": 0,
                "impressions": 0,
                "clicks": 0,
                "purchases": 0,
                "total_business_sales": 0,
            }
        )
        for key in ("ctr", "cpc", "acos", "tacos", "attributed_sales_share", "conversion_rate"):
            self.assertIsNone(row[key], key)
        self.assertEqual(row["roas"], 0)

    def test_rules_are_named_versioned_maturity_aware_and_non_economic(self):
        self.assertTrue(INTERPRETATION_RULES)
        for key, rule in INTERPRETATION_RULES.items():
            self.assertEqual(rule["key"], key)
            self.assertGreaterEqual(rule["version"], 1)
            self.assertTrue(rule["eligibility"])
            self.assertTrue(rule["thresholds"])
            self.assertEqual(rule["observation_window"]["days"], 28)
            self.assertTrue(rule["attribution_maturity"])
            self.assertFalse(rule["economic_claims_allowed"])
            self.assertTrue(rule["plain_language"])
            self.assertTrue(rule["evidence_fields"])
        self.assertFalse(ECONOMICS_CONTRACT["authoritative"])
        self.assertIn("commission", " ".join(ECONOMICS_CONTRACT["missing_inputs"]))

    def test_products_are_ordered_by_decision_relevance_and_suppress_immature_rules(self):
        rows = enrich_products(
            [
                {
                    "sku": "ZERO",
                    "product": "Zero conversion",
                    "spend": 100,
                    "impressions": 1000,
                    "clicks": 12,
                    "purchases": 0,
                    "attributed_sales": 0,
                    "total_business_sales": 500,
                    "observed_ads_days": 28,
                    "mature_ads_days": 21,
                },
                {
                    "sku": "LEARN",
                    "product": "Learning product",
                    "spend": 300,
                    "impressions": 1000,
                    "clicks": 20,
                    "purchases": 0,
                    "attributed_sales": 0,
                    "total_business_sales": 500,
                    "observed_ads_days": 8,
                    "mature_ads_days": 1,
                },
                {
                    "sku": "BUY",
                    "product": "Converting product",
                    "spend": 50,
                    "impressions": 1000,
                    "clicks": 10,
                    "purchases": 2,
                    "attributed_sales": 80,
                    "total_business_sales": 300,
                    "observed_ads_days": 28,
                    "mature_ads_days": 21,
                },
            ],
            trusted=True,
            attribution_lookback_days=7,
        )
        self.assertEqual([row["sku"] for row in rows], ["ZERO", "BUY", "LEARN"])
        self.assertEqual(rows[0]["recommendation"]["state"], "NEEDS_ATTENTION")
        self.assertEqual(rows[1]["recommendation"]["state"], "OPPORTUNITY_TEST")
        self.assertEqual(rows[2]["recommendation"]["state"], "SUPPORTED_MONITOR")
        self.assertFalse(rows[2]["recommendation"]["eligible"])
        self.assertIn("observed", rows[2]["recommendation"]["suppression_reason"])

    def test_signal_normalization_separates_queries_products_and_raw_evidence(self):
        query = normalize_demand_signal(
            {
                "account_id": "a",
                "campaign_id": "c",
                "target_id": "t",
                "search_term": "field notes",
                "match_type": "exact",
                "clicks": 8,
                "purchases": 2,
                "spend": 20,
                "attributed_sales": 50,
                "impressions": 100,
            },
            source="search_term",
            product_refs=[{"sku": "PNC-001", "product": "Pocket Notebooks"}],
            trusted=True,
            mature_days=21,
            observed_days=28,
        )
        product = normalize_demand_signal(
            {
                "account_id": "a",
                "campaign_id": "c",
                "target_id": "t2",
                "search_term": "b07k4xy6pt",
                "clicks": 2,
                "purchases": 0,
                "spend": 4,
                "attributed_sales": 0,
                "impressions": 100,
            },
            source="search_term",
            product_refs=[],
            trusted=True,
            mature_days=21,
            observed_days=28,
        )
        self.assertEqual(query["signal_type"], "SHOPPER_QUERY")
        self.assertEqual(query["recommendation"]["state"], "OPPORTUNITY_TEST")
        self.assertEqual(query["product_context"], "Pocket Notebooks")
        self.assertEqual(product["signal_type"], "MATCHED_PRODUCT")
        self.assertEqual(product["signal"], "B07K4XY6PT")
        self.assertEqual(query["technical"]["target_id"], "t")
        self.assertEqual(query["recommendation"]["evidence"]["required_mature_days"], 21)
        still_learning = normalize_demand_signal(
            {
                "account_id": "a",
                "campaign_id": "c",
                "target_id": "t3",
                "search_term": "custom lookback",
                "clicks": 8,
                "purchases": 2,
                "spend": 20,
                "attributed_sales": 50,
                "impressions": 100,
            },
            source="search_term",
            product_refs=[],
            trusted=True,
            mature_days=21,
            observed_days=28,
            attribution_lookback_days=3,
        )
        self.assertFalse(still_learning["recommendation"]["eligible"])
        self.assertEqual(
            still_learning["recommendation"]["evidence"]["required_mature_days"], 25
        )

    def test_group_allocation_keeps_product_actions_from_being_crowded_out(self):
        products = enrich_products(
            [
                {
                    "sku": "P1",
                    "product": "Product One",
                    "spend": 100,
                    "impressions": 1000,
                    "clicks": 10,
                    "purchases": 0,
                    "attributed_sales": 0,
                    "total_business_sales": 500,
                    "observed_ads_days": 28,
                    "mature_ads_days": 21,
                }
            ],
            trusted=True,
            attribution_lookback_days=7,
        )
        signals = []
        for index in range(20):
            signals.append(
                normalize_demand_signal(
                    {
                        "account_id": "a",
                        "campaign_id": "c",
                        "target_id": str(index),
                        "search_term": f"query {index}",
                        "clicks": 20,
                        "purchases": 3,
                        "spend": 1000 - index,
                        "attributed_sales": 2000,
                        "impressions": 1000,
                    },
                    source="search_term",
                    product_refs=[],
                    trusted=True,
                    mature_days=21,
                    observed_days=28,
                )
            )
        actions, groups = build_action_groups(products, signals)
        self.assertLessEqual(len(actions), 8)
        self.assertTrue(any(action["lane"] == "PRODUCT" for action in actions))
        self.assertEqual(groups[0]["key"], "PRODUCT")
        self.assertEqual(groups[0]["shown"], 1)
        self.assertEqual(actions, build_action_groups(products, signals)[0])

    def test_demand_pagination_filtering_and_invalid_page_are_deterministic(self):
        signals = []
        for index in range(45):
            signals.append(
                {
                    "signal_id": f"signal-{index}",
                    "signal": f"query {index}",
                    "signal_type": "SHOPPER_QUERY",
                    "campaign_id": "campaign-a" if index % 2 == 0 else "campaign-b",
                    "campaign_name": "Campaign A" if index % 2 == 0 else "Campaign B",
                    "product_context": "Product One",
                    "product_refs": [{"sku": "P1"}],
                    "spend": index,
                    "purchases": index % 3,
                    "attributed_sales": index * 2,
                    "recommendation": {"state": "OPPORTUNITY_TEST" if index % 3 else "NEEDS_ATTENTION"},
                }
            )
        page = demand_page(signals, {"sku": "P1", "campaign": "campaign-a", "page": "99", "sort": "spend-desc"})
        self.assertEqual(page["total"], 23)
        self.assertEqual(page["page_count"], 2)
        self.assertEqual(page["page"], 2)
        self.assertEqual(len(page["items"]), 3)
        self.assertEqual(page["sort"], "spend-desc")
        fallback = demand_page(signals, {"page": "invalid", "sort": "unknown"})
        self.assertEqual(fallback["page"], 1)
        self.assertEqual(fallback["sort"], "decision")


if __name__ == "__main__":
    unittest.main()
