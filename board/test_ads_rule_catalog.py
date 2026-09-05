from __future__ import annotations

from pathlib import Path
import unittest

from ads_rule_catalog import (
    ECONOMICS_CONTRACT,
    INTERPRETATION_RULES,
    SEARCH_OPPORTUNITY_RULES,
    TARGET_DECISION_CATALOG,
)
from ads_shadow_rules import SHADOW_RULE_VERSIONS


class AdvertisingRuleOwnerTests(unittest.TestCase):
    def test_target_catalog_matches_published_v2_kinds(self):
        self.assertEqual(
            set(TARGET_DECISION_CATALOG),
            {
                "ADS_DATA_BLOCKER",
                "ADS_INVENTORY_CONFLICT",
                "ADS_ECONOMIC_LEAKAGE",
                "ADS_QUERY_LEAKAGE",
                "ADS_PRODUCT_CONVERSION_GAP",
                "ADS_SQP_VISIBILITY_GAP",
                "ADS_SQP_CLICK_GAP",
                "ADS_SQP_CART_GAP",
                "ADS_SQP_PURCHASE_GAP",
                "ADS_QUERY_TEST",
                "ADS_BUDGET_CONSTRAINT",
                "ADS_PRODUCT_ALLOCATION_TEST",
                "ADS_EXPERIMENT_EVALUATION",
            },
        )
        migration = (
            Path(__file__).parent.parent
            / "sql"
            / "migrations"
            / "073_decision_contract_and_ledger.sql"
        ).read_text()
        for kind in TARGET_DECISION_CATALOG:
            self.assertIn(f"('{kind}'", migration)

    def test_every_v2_catalog_entry_has_a_bounded_initial_action_class(self):
        for lane, action_class in TARGET_DECISION_CATALOG.values():
            self.assertIn(lane, ("PROTECT", "ELIMINATE", "CAPTURE", "ALLOCATE", "LEARN"))
            self.assertIn(action_class, ("OBSERVE", "INVESTIGATE", "TEST"))

    def test_legacy_observations_remain_non_economic_during_cutover(self):
        self.assertFalse(ECONOMICS_CONTRACT["authoritative"])
        for rule in INTERPRETATION_RULES.values():
            self.assertFalse(rule["economic_claims_allowed"])
        combined = str(SEARCH_OPPORTUNITY_RULES).lower()
        self.assertNotIn("incremental", combined)
        self.assertNotIn("increase budget", combined)

    def test_initial_shadow_rule_versions_are_complete_and_non_prescriptive(self):
        migration = (
            Path(__file__).parent.parent
            / "sql"
            / "migrations"
            / "074_ads_initial_shadow_rules.sql"
        ).read_text()
        self.assertEqual(
            set(SHADOW_RULE_VERSIONS),
            {"ADS_DATA_BLOCKER", "ADS_INVENTORY_CONFLICT", "ADS_PRODUCT_CONVERSION_GAP"},
        )
        for key, version in SHADOW_RULE_VERSIONS.items():
            self.assertEqual(version, 2)
            self.assertIn(f"'{key}'", migration)
        self.assertIn("'COMPLETE'", migration)
        self.assertIn("'SHADOW'", migration)
        self.assertNotIn("'ACTIVE'", migration)
        self.assertNotIn("'EXECUTE'", migration)


if __name__ == "__main__":
    unittest.main()
