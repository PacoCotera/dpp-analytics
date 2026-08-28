from __future__ import annotations

import unittest

from .catalog import _resolved_parent_relationships


MARKETPLACE = "A1AM78C64UM0Y8"


def _item(
    asin: str,
    *,
    parent_asins: list[str] | None = None,
    child_asins: list[str] | None = None,
) -> dict:
    relationship: dict[str, object] = {"type": "VARIATION"}
    if parent_asins is not None:
        relationship["parentAsins"] = parent_asins
    if child_asins is not None:
        relationship["childAsins"] = child_asins
    return {
        "asin": asin,
        "relationships": [
            {
                "marketplaceId": MARKETPLACE,
                "relationships": [relationship],
            }
        ],
    }


class CatalogRelationshipTests(unittest.TestCase):
    def test_direct_child_parent_and_standalone_clear(self) -> None:
        resolved = _resolved_parent_relationships(
            [_item("CHILD", parent_asins=["PARENT"]), {"asin": "STANDALONE"}]
        )
        self.assertEqual(resolved, {"CHILD": "PARENT", "STANDALONE": None})

    def test_parent_child_list_fills_missing_direct_parent(self) -> None:
        resolved = _resolved_parent_relationships(
            [_item("CHILD"), _item("PARENT", child_asins=["CHILD"])]
        )
        self.assertEqual(resolved, {"CHILD": "PARENT", "PARENT": None})

    def test_matching_child_and_parent_evidence_is_order_independent(self) -> None:
        child = _item("CHILD", parent_asins=["PARENT"])
        parent = _item("PARENT", child_asins=["CHILD"])
        self.assertEqual(
            _resolved_parent_relationships([child, parent]),
            _resolved_parent_relationships([parent, child]),
        )
        self.assertEqual(
            _resolved_parent_relationships([child, parent]),
            {"CHILD": "PARENT", "PARENT": None},
        )

    def test_conflicting_amazon_parent_evidence_fails_closed(self) -> None:
        with self.assertRaisesRegex(
            RuntimeError,
            r"conflicting variation parents: CHILD=>PARENT_A/PARENT_B",
        ):
            _resolved_parent_relationships(
                [
                    _item("CHILD", parent_asins=["PARENT_A"]),
                    _item("PARENT_B", child_asins=["CHILD"]),
                ]
            )

    def test_multiple_direct_parents_fail_closed(self) -> None:
        with self.assertRaisesRegex(
            RuntimeError,
            r"conflicting variation parents: CHILD=>PARENT_A/PARENT_B",
        ):
            _resolved_parent_relationships(
                [_item("CHILD", parent_asins=["PARENT_B", "PARENT_A"])]
            )

    def test_self_parent_relationship_fails_closed(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "self-parent relationship"):
            _resolved_parent_relationships([_item("PARENT", child_asins=["PARENT"])])


if __name__ == "__main__":
    unittest.main()
