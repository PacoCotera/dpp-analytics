from __future__ import annotations

import unittest

from decision_resolver import ResolutionError, resolve_conditions


def condition(domain: str, resolution: str, code: str) -> dict:
    return {
        "domain": domain,
        "code": code,
        "resolution": resolution,
        "rule_key": f"{domain}_{code}_V1",
        "reason": f"{domain} says {code}",
        "operands": [{"fact": f"{domain.lower()}.{code.lower()}", "value": True}],
    }


class DecisionResolverTests(unittest.TestCase):
    def test_safety_precedence_is_order_independent_and_traceable(self):
        items = [
            condition("FINANCE", "QUALIFY", "PROVISIONAL"),
            condition("INVENTORY", "TRANSFORM", "LOW_STOCK"),
            condition("DATA_HEALTH", "BLOCK_DOMAIN", "ADS_FAILED"),
            condition("PRODUCT", "SUPPRESS", "DELETED"),
        ]
        items[1]["transformed_action"] = {"action_type": "REVIEW_REPLENISHMENT"}
        forward = resolve_conditions(items)
        reverse = resolve_conditions(reversed(items))
        self.assertEqual(forward, reverse)
        self.assertEqual(forward["outcome"], "BLOCK_DOMAIN")
        self.assertEqual(forward["suppression"]["rule_key"], "DATA_HEALTH_ADS_FAILED_V1")
        self.assertEqual(len(forward["blockers"]), 2)

    def test_transform_requires_an_explicit_replacement_action(self):
        with self.assertRaisesRegex(ResolutionError, "transformed_action"):
            resolve_conditions([condition("INVENTORY", "TRANSFORM", "LOW_STOCK")])

    def test_empty_conditions_allow_without_inventing_evidence(self):
        result = resolve_conditions([])
        self.assertEqual(result["outcome"], "ALLOW")
        self.assertEqual(result["conditions"], [])


if __name__ == "__main__":
    unittest.main()
