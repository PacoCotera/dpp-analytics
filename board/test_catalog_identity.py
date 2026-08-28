from __future__ import annotations

import unittest

from catalog_api import (
    _apply_canonical_identity,
    _catalog_summary,
    _commercial_state,
    _identity_violations,
)


class CatalogIdentityTest(unittest.TestCase):
    def test_child_variation_identity_agrees_with_parent_and_family(self):
        row = _apply_canonical_identity(
            {
                "sku": "PNC-001L",
                "asin": "B0HGBTLT94",
                "parent_asin": "B0GGQHV45F",
                "family_asin": "B0GGQHV45F",
                "product_role": "SELLABLE_VARIATION",
                "family_name": None,
            }
        )

        self.assertEqual(row["identity"]["kind"], "CHILD_VARIATION")
        self.assertEqual(row["identity"]["family_label"], "Variation family")
        self.assertEqual(row["identity"]["parent_asin"], "B0GGQHV45F")
        self.assertEqual(row["identity"]["family_asin"], "B0GGQHV45F")
        self.assertTrue(row["identity"]["consistent"])
        self.assertEqual(_identity_violations([row]), [])

    def test_seller_family_name_labels_variation_without_changing_identity(self):
        row = _apply_canonical_identity(
            {
                "sku": "CHILD",
                "asin": "BCHILD",
                "parent_asin": "BPARENT",
                "family_asin": "BPARENT",
                "product_role": "SELLABLE_VARIATION",
                "family_name": "Pocket notebooks",
            }
        )

        self.assertEqual(row["identity"]["family_label"], "Pocket notebooks")
        self.assertEqual(row["identity"]["kind"], "CHILD_VARIATION")

    def test_source_self_parent_is_normalized_to_standalone_audit_evidence(self):
        row = _apply_canonical_identity(
            {
                "sku": "STANDALONE",
                "asin": "BSELF",
                "parent_asin": "BSELF",
                "family_asin": "BSELF",
                "product_role": "SELLABLE_STANDALONE",
            }
        )

        self.assertIsNone(row["parent_asin"])
        self.assertEqual(row["source_parent_asin"], "BSELF")
        self.assertEqual(row["identity"]["kind"], "STANDALONE_OFFER")
        self.assertEqual(row["identity"]["family_label"], "Standalone product")
        self.assertTrue(row["identity"]["consistent"])

    def test_true_standalone_has_own_family_key(self):
        row = _apply_canonical_identity(
            {
                "sku": "STANDALONE",
                "asin": "BOWN",
                "parent_asin": None,
                "family_asin": "BOWN",
                "product_role": "SELLABLE_STANDALONE",
            }
        )
        self.assertTrue(row["identity"]["consistent"])
        self.assertEqual(_identity_violations([row]), [])

    def test_structural_parent_is_a_non_sellable_container(self):
        row = _apply_canonical_identity(
            {
                "sku": "PNC-CURRENT",
                "asin": "B0HGNS3FHB",
                "parent_asin": None,
                "family_asin": "B0HGNS3FHB",
                "product_role": "STRUCTURAL_PARENT",
                "product": "Pocket collections",
            }
        )

        self.assertEqual(row["identity"]["kind"], "VARIATION_CONTAINER")
        self.assertFalse(row["identity"]["is_sellable"])
        self.assertTrue(row["identity"]["consistent"])

    def test_structural_parent_is_excluded_from_sellable_summary(self):
        rows = [
            {
                "sku": "PARENT-ONLY",
                "family_asin": "PARENT-FAMILY",
                "product_role": "STRUCTURAL_PARENT",
                "status": "Inactive",
            },
            {
                "sku": "CHILD",
                "family_asin": "CHILD-FAMILY",
                "product_role": "SELLABLE_VARIATION",
                "status": "Active",
            },
        ]

        summary = _catalog_summary(rows)

        self.assertEqual(summary["listing_records"], 2)
        self.assertEqual(summary["structural_parents"], 1)
        self.assertEqual(summary["sellable_offers"], 1)
        self.assertEqual(summary["active_sellable"], 1)
        self.assertEqual(summary["inactive_sellable"], 0)
        self.assertEqual(summary["families"], 1)

    def test_deleted_history_is_not_a_current_offer_or_catalog_record(self):
        rows = [
            {
                "sku": "CURRENT",
                "family_asin": "BCURRENT",
                "product_role": "SELLABLE_STANDALONE",
                "catalog_membership": "CURRENT_OFFER",
                "is_current_listing": True,
                "status": "Active",
            },
            {
                "sku": "CLOSED",
                "family_asin": "BCLOSED",
                "product_role": "SELLABLE_STANDALONE",
                "catalog_membership": "CURRENT_OFFER",
                "is_current_listing": True,
                "status": "Closed",
            },
            {
                "sku": "DELETED",
                "family_asin": "BDELETED",
                "product_role": "SELLABLE_VARIATION",
                "catalog_membership": "DELETED",
                "is_current_listing": False,
                "status": "Active",
            },
            {
                "sku": "PARENT",
                "family_asin": "BPARENT",
                "product_role": "STRUCTURAL_PARENT",
                "catalog_membership": "CURRENT_PARENT",
                "is_current_listing": False,
                "status": "Inactive",
            },
        ]

        summary = _catalog_summary(rows)

        self.assertEqual(summary["listing_records"], 2)
        self.assertEqual(summary["catalog_entities"], 4)
        self.assertEqual(summary["sellable_offers"], 2)
        self.assertEqual(summary["active_sellable"], 1)
        self.assertEqual(summary["inactive_sellable"], 1)
        self.assertEqual(summary["families"], 2)

        deleted = _apply_canonical_identity(rows[2])
        self.assertFalse(deleted["identity"]["is_sellable"])
        self.assertEqual(_identity_violations([deleted]), [])

    def test_current_non_active_statuses_remain_distinct_from_deleted(self):
        base = {
            "product_role": "SELLABLE_STANDALONE",
            "catalog_membership": "CURRENT_OFFER",
        }

        self.assertEqual(_commercial_state({**base, "status": "Closed"}, 0, 0)[0], "CLOSED")
        self.assertEqual(_commercial_state({**base, "status": "Inactive"}, 0, 0)[0], "INACTIVE")
        self.assertEqual(_commercial_state({**base, "status": "Incomplete"}, 0, 0)[0], "INCOMPLETE")
        self.assertEqual(
            _commercial_state({**base, "status": "Active", "catalog_membership": "DELETED"}, 0, 0)[0],
            "DELETED",
        )

    def test_every_contradictory_sellable_role_is_reported(self):
        rows = [
            _apply_canonical_identity(
                {
                    "sku": "CHILD-NO-PARENT",
                    "asin": "BCHILD",
                    "parent_asin": None,
                    "family_asin": "BCHILD",
                    "product_role": "SELLABLE_VARIATION",
                }
            ),
            _apply_canonical_identity(
                {
                    "sku": "STANDALONE-WRONG-FAMILY",
                    "asin": "BSTANDALONE",
                    "parent_asin": None,
                    "family_asin": "BOTHER",
                    "product_role": "SELLABLE_STANDALONE",
                }
            ),
        ]

        violations = _identity_violations(rows)
        self.assertEqual({item["sku"] for item in violations}, {"CHILD-NO-PARENT", "STANDALONE-WRONG-FAMILY"})
        self.assertTrue(all(item["conflicts"] for item in violations))


if __name__ == "__main__":
    unittest.main()
