from __future__ import annotations

import unittest
from unittest.mock import patch

from catalog_onboarding import catalog_onboarding_snapshot


class FakeCursor:
    def __init__(self, rows):
        self.rows = rows

    def execute(self, sql, params=()):
        return None

    def fetchall(self):
        return [dict(row) for row in self.rows]

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


class FakeConnection:
    def __init__(self, rows):
        self.rows = rows

    def cursor(self):
        return FakeCursor(self.rows)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


def connect_with(rows):
    return lambda: FakeConnection(rows)


class CatalogOnboardingTest(unittest.TestCase):
    def test_deleted_history_is_excluded_from_onboarding(self):
        rows = [
            {
                "sku": "DELETED-001",
                "asin": "BDELETED",
                "product_role": "SELLABLE_VARIATION",
                "catalog_membership": "DELETED",
                "source_state": "SOURCE_READY",
                "is_onboarding": False,
                "source_attention": True,
            },
            {
                "sku": "CURRENT-001",
                "asin": "BCURRENT",
                "product_role": "SELLABLE_STANDALONE",
                "catalog_membership": "CURRENT_OFFER",
                "source_state": "SOURCE_READY",
                "is_onboarding": False,
                "source_attention": False,
            },
        ]
        with patch("catalog_onboarding._taxonomy_skus", return_value={"CURRENT-001"}):
            payload = catalog_onboarding_snapshot(connect_with(rows), "MX")

        self.assertEqual([row["sku"] for row in payload["items"]], ["CURRENT-001"])
        self.assertEqual(payload["summary"]["active_listings"], 1)
        self.assertEqual(payload["summary"]["source_attention"], 0)

    def test_current_closed_and_inactive_statuses_remain_distinct(self):
        rows = [
            {
                "sku": "CLOSED-001",
                "status": "Closed",
                "source_state": "CLOSED",
                "is_onboarding": False,
                "source_attention": False,
            },
            {
                "sku": "INACTIVE-001",
                "status": "Inactive",
                "source_state": "INACTIVE",
                "is_onboarding": False,
                "source_attention": False,
            },
        ]
        with patch("catalog_onboarding._taxonomy_skus", return_value=set()):
            payload = catalog_onboarding_snapshot(connect_with(rows), "MX")

        by_sku = {row["sku"]: row for row in payload["items"]}
        self.assertEqual(by_sku["CLOSED-001"]["taxonomy_state"], "CLOSED")
        self.assertEqual(by_sku["INACTIVE-001"]["taxonomy_state"], "INACTIVE")
        self.assertEqual(payload["summary"]["active_listings"], 0)
        self.assertEqual(payload["summary"]["inactive_listings"], 2)

    def test_structural_parents_are_excluded_from_onboarding_and_counts(self):
        rows = [
            {
                "sku": "PNC-CURRENT",
                "asin": "B0HGNS3FHB",
                "product_role": "STRUCTURAL_PARENT",
                "source_state": "INACTIVE",
                "is_onboarding": True,
                "source_attention": False,
            },
            {
                "sku": "CHILD",
                "asin": "BCHILD",
                "product_role": "SELLABLE_VARIATION",
                "source_state": "SOURCE_READY",
                "is_onboarding": True,
                "source_attention": False,
            },
        ]
        with patch("catalog_onboarding._taxonomy_skus", return_value=set()):
            payload = catalog_onboarding_snapshot(connect_with(rows), "MX")

        self.assertEqual([row["sku"] for row in payload["items"]], ["CHILD"])
        self.assertEqual(payload["summary"]["onboarding"], 1)
        self.assertNotIn("PNC-CURRENT", [row["sku"] for row in payload["attention"]])

    def test_new_source_ready_unmapped_is_onboarding_not_actionable(self):
        rows = [
            {
                "sku": "NEW-001",
                "asin": "BNEW001",
                "source_state": "SOURCE_READY",
                "age_seconds": 3600,
                "is_onboarding": True,
                "source_attention": False,
            }
        ]
        with patch("catalog_onboarding._taxonomy_skus", return_value=set()):
            payload = catalog_onboarding_snapshot(connect_with(rows), "MX")
        item = payload["items"][0]
        self.assertEqual(item["taxonomy_state"], "ONBOARDING")
        self.assertFalse(item["requires_seller_action"])
        self.assertEqual(payload["summary"]["onboarding"], 1)
        self.assertEqual(payload["summary"]["taxonomy_attention"], 0)

    def test_established_source_ready_unmapped_requires_mapping(self):
        rows = [
            {
                "sku": "OLD-001",
                "asin": "BOLD001",
                "source_state": "SOURCE_READY",
                "age_seconds": 72 * 3600,
                "is_onboarding": False,
                "source_attention": False,
            }
        ]
        with patch("catalog_onboarding._taxonomy_skus", return_value=set()):
            payload = catalog_onboarding_snapshot(connect_with(rows), "MX")
        item = payload["items"][0]
        self.assertEqual(item["taxonomy_state"], "MAPPING_REQUIRED")
        self.assertTrue(item["requires_seller_action"])
        self.assertEqual(payload["summary"]["taxonomy_attention"], 1)

    def test_overdue_source_gap_stays_source_attention_not_taxonomy_failure(self):
        rows = [
            {
                "sku": "PROP-001",
                "asin": "BPROP001",
                "source_state": "CATALOG_PROPAGATING",
                "age_seconds": 72 * 3600,
                "is_onboarding": False,
                "source_attention": True,
            }
        ]
        with patch("catalog_onboarding._taxonomy_skus", return_value=set()):
            payload = catalog_onboarding_snapshot(connect_with(rows), "MX")
        item = payload["items"][0]
        self.assertEqual(item["taxonomy_state"], "ONBOARDING")
        self.assertTrue(item["requires_seller_action"])
        self.assertEqual(payload["summary"]["source_attention"], 1)
        self.assertEqual(payload["summary"]["taxonomy_attention"], 0)

    def test_mapped_sku_is_mapped_even_while_source_is_propagating(self):
        rows = [
            {
                "sku": "MAP-001",
                "asin": "BMAP001",
                "source_state": "CATALOG_PROPAGATING",
                "age_seconds": 3600,
                "is_onboarding": True,
                "source_attention": False,
            }
        ]
        with patch("catalog_onboarding._taxonomy_skus", return_value={"MAP-001"}):
            payload = catalog_onboarding_snapshot(connect_with(rows), "MX")
        item = payload["items"][0]
        self.assertEqual(item["taxonomy_state"], "MAPPED")
        self.assertFalse(item["requires_seller_action"])
        self.assertEqual(payload["summary"]["seller_mapped"], 1)

    def test_new_inactive_listing_remains_onboarding_evidence(self):
        rows = [
            {
                "sku": "NEW-INACTIVE",
                "asin": "BNEWINACTIVE",
                "status": "inactive",
                "source_state": "INACTIVE",
                "age_seconds": 2 * 3600,
                "is_onboarding": True,
                "source_attention": False,
            }
        ]
        with patch("catalog_onboarding._taxonomy_skus", return_value=set()):
            payload = catalog_onboarding_snapshot(connect_with(rows), "MX")
        item = payload["items"][0]
        self.assertEqual(item["taxonomy_state"], "ONBOARDING")
        self.assertFalse(item["requires_seller_action"])
        self.assertEqual(payload["summary"]["active_listings"], 0)
        self.assertEqual(payload["summary"]["inactive_listings"], 1)
        self.assertEqual(payload["summary"]["onboarding"], 1)

    def test_established_inactive_listing_never_requires_taxonomy_action(self):
        rows = [
            {
                "sku": "OLD-INACTIVE",
                "asin": "BOLDINACTIVE",
                "status": "inactive",
                "source_state": "INACTIVE",
                "age_seconds": 90 * 24 * 3600,
                "is_onboarding": False,
                "source_attention": False,
            }
        ]
        with patch("catalog_onboarding._taxonomy_skus", return_value=set()):
            payload = catalog_onboarding_snapshot(connect_with(rows), "MX")
        item = payload["items"][0]
        self.assertEqual(item["taxonomy_state"], "INACTIVE")
        self.assertFalse(item["requires_seller_action"])
        self.assertEqual(payload["summary"]["onboarding"], 0)
        self.assertEqual(payload["summary"]["taxonomy_attention"], 0)


if __name__ == "__main__":
    unittest.main()
