from __future__ import annotations

import unittest

from catalog_api import _apply_canonical_identity, _identity_violations


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
