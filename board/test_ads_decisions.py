from __future__ import annotations

import unittest

from ads_decisions import (
    ECONOMICS_CONTRACT,
    INTERPRETATION_RULES,
    SEARCH_OPPORTUNITY_RULES,
    build_search_query_opportunities,
    build_action_groups,
    demand_page,
    enrich_products,
    inventory_exposure_recommendation,
    metric_contract,
    normalize_search_query_key,
    normalize_demand_signal,
    paid_support_by_query,
    safe_ratio,
    search_query_opportunity,
)


class AdsDecisionContractTests(unittest.TestCase):
    def _search_row(self, **overrides):
        row = {
            "start_date": "2026-08-01",
            "asin": "B012345678",
            "sku": "SKU-ONE",
            "product": "Daily planning notebook",
            "search_query": "daily planner",
            "search_query_key": "daily planner",
            "search_query_volume": 5000,
            "total_query_impression_count": 10000,
            "asin_impression_count": 400,
            "asin_impression_share": 0.04,
            "total_click_count": 1000,
            "asin_click_count": 10,
            "total_cart_add_count": 400,
            "asin_cart_add_count": 4,
            "total_purchase_count": 200,
            "asin_purchase_count": 2,
        }
        row.update(overrides)
        return row

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

    def test_search_query_keys_follow_nfkc_whitespace_and_case_contract(self):
        self.assertEqual(normalize_search_query_key("  FIELD\u3000Notes  "), "field notes")
        self.assertEqual(normalize_search_query_key("Ｆｉｅｌｄ Notes"), "field notes")

    def test_same_month_paid_support_is_query_level_and_aggregated(self):
        grouped = paid_support_by_query(
            [
                {
                    "search_term": " Field  Notes ",
                    "campaign_id": "one",
                    "spend": 12,
                    "clicks": 3,
                    "purchases": 1,
                    "attributed_sales": 20,
                },
                {
                    "search_term": "field notes",
                    "campaign_id": "two",
                    "spend": 8,
                    "clicks": 2,
                    "purchases": 0,
                    "attributed_sales": 0,
                },
            ]
        )["field notes"]
        self.assertEqual(grouped["spend"], 20)
        self.assertEqual(grouped["clicks"], 5)
        self.assertEqual(grouped["campaign_count"], 2)
        self.assertIn("query-level", grouped["basis"])

    def test_search_funnel_uses_deepest_qualified_gap_and_scenario_math(self):
        purchase = search_query_opportunity(
            self._search_row(
                asin_impression_count=500,
                asin_click_count=50,
                asin_cart_add_count=10,
                asin_purchase_count=2,
            )
        )
        self.assertEqual(purchase["rule_key"], "SQP_PURCHASE_GAP")
        self.assertEqual(purchase["scenario"]["low"], 0.75)
        self.assertEqual(purchase["scenario"]["high"], 1.5)

        cart = search_query_opportunity(
            self._search_row(
                asin_impression_count=200,
                asin_click_count=20,
                asin_cart_add_count=2,
                asin_purchase_count=1,
            )
        )
        self.assertEqual(cart["rule_key"], "SQP_CART_GAP")
        self.assertEqual(cart["scenario"]["low"], 0.75)
        self.assertEqual(cart["scenario"]["high"], 1.5)

        click = search_query_opportunity(self._search_row())
        self.assertEqual(click["rule_key"], "SQP_CLICK_GAP")
        self.assertEqual(click["scenario"]["low"], 1.5)
        self.assertEqual(click["scenario"]["high"], 3.0)
        self.assertIn("not a forecast", click["scenario"]["basis"])

    def test_sparse_rows_are_suppressed_and_visibility_is_lower_priority(self):
        sparse = search_query_opportunity(
            self._search_row(
                search_query_volume=50,
                total_query_impression_count=500,
                asin_impression_count=99,
                asin_click_count=0,
                asin_cart_add_count=0,
                asin_purchase_count=0,
            )
        )
        self.assertIsNone(sparse)
        visibility_row = self._search_row(
            asin_impression_count=50,
            asin_impression_share=0.005,
            asin_click_count=5,
            asin_cart_add_count=2,
            asin_purchase_count=1,
            search_query="broad notebook",
            search_query_key="broad notebook",
        )
        click_row = self._search_row(search_query="specific notebook", search_query_key="specific notebook")
        ranked = build_search_query_opportunities([visibility_row, click_row], [])
        self.assertEqual(ranked[0]["rule_key"], "SQP_CLICK_GAP")
        self.assertEqual(ranked[1]["rule_key"], "SQP_VISIBILITY_REVIEW")
        self.assertEqual(ranked[1]["confidence"]["state"], "HIGH")
        self.assertFalse(ranked[1]["paid_support"]["exact_query_match"])

    def test_search_rules_are_versioned_and_non_prescriptive(self):
        self.assertEqual(set(SEARCH_OPPORTUNITY_RULES), {
            "SQP_PURCHASE_GAP", "SQP_CART_GAP", "SQP_CLICK_GAP", "SQP_VISIBILITY_REVIEW"
        })
        combined = " ".join(
            f"{rule['comparison']} {rule['review']}" for rule in SEARCH_OPPORTUNITY_RULES.values()
        ).lower()
        for prohibited in ("increase bid", "decrease bid", "increase budget", "organic sales", "incremental"):
            self.assertNotIn(prohibited, combined)

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
        self.assertEqual(rows[0]["recommendation"]["title"], "Review listing relevance")
        self.assertEqual(rows[1]["recommendation"]["title"], "Review converting demand")
        self.assertEqual(rows[2]["recommendation"]["title"], "Monitor paid support")
        self.assertFalse(rows[2]["recommendation"]["eligible"])
        self.assertIn("observed", rows[2]["recommendation"]["suppression_reason"])

    def test_inventory_exposure_requires_current_constrained_offer_and_mature_ads(self):
        base = {
            "sku": "PNC-001",
            "product": "Pocket Notebook",
            "is_current_offer": True,
            "inventory_action": "PRODUCE",
            "available": 4,
            "inbound": 0,
            "days_cover_with_inbound": 9,
            "ad_spend_t28": 120,
            "ad_attributed_sales_t28": 180,
            "ad_tacos_t28": 0.3,
            "ad_observed_days": 28,
            "ad_mature_days": 21,
        }
        decision = inventory_exposure_recommendation(
            base,
            trusted=True,
            attribution_lookback_days=7,
        )
        self.assertTrue(decision["eligible"])
        self.assertEqual(decision["state"], "NEEDS_ATTENTION")
        self.assertEqual(decision["rule_key"], "ADS_INVENTORY_EXPOSURE_REVIEW")
        self.assertEqual(decision["destination"]["sku"], "PNC-001")
        self.assertIn("not a recommendation", decision["qualification"])

        for field, value, expected in (
            ("is_current_offer", False, "canonical current offer"),
            ("inventory_action", "OK", "has not assigned"),
            ("ad_spend_t28", 0, "No paid support"),
            ("ad_mature_days", 20, "eligible attribution days"),
        ):
            row = dict(base)
            row[field] = value
            suppressed = inventory_exposure_recommendation(
                row,
                trusted=True,
                attribution_lookback_days=7,
            )
            self.assertFalse(suppressed["eligible"], field)
            self.assertIn(expected, suppressed["suppression_reason"], field)

    def test_inventory_exposure_action_id_is_stable_and_non_prescriptive(self):
        row = {
            "sku": "PNC-004",
            "product": "Pocket Notebook",
            "is_current_offer": True,
            "inventory_action": "PLAN",
            "available": 10,
            "inbound": 0,
            "days_cover_with_inbound": 26,
            "ad_spend_t28": 50,
            "ad_observed_days": 28,
            "ad_mature_days": 21,
        }
        first = inventory_exposure_recommendation(row, trusted=True)
        second = inventory_exposure_recommendation(dict(row), trusted=True)
        self.assertEqual(first["action_id"], second["action_id"])
        combined = " ".join(
            [first["title"], first["explanation"], *first["review_steps"]]
        ).lower()
        for prohibited in ("pause campaigns", "reduce spend", "increase budget", "scale"):
            self.assertNotIn(prohibited, combined)

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
        configured_target = normalize_demand_signal(
            {
                "account_id": "a",
                "campaign_id": "c",
                "target_id": "429271729326675",
                "target_expression": None,
                "target_type": "close_match",
                "clicks": 2,
                "purchases": 0,
                "spend": 4,
                "attributed_sales": 0,
                "impressions": 100,
            },
            source="target",
            product_refs=[],
            trusted=True,
            mature_days=21,
            observed_days=28,
        )
        self.assertEqual(configured_target["signal_type"], "TARGET")
        self.assertEqual(
            configured_target["signal"],
            "Configured target (expression unavailable)",
        )
        self.assertNotEqual(
            configured_target["signal"], configured_target["technical"]["target_id"]
        )
        self.assertIsNone(configured_target["technical"]["raw_value"])
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
