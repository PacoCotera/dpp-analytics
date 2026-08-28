from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from admin_config import (
    AdminConfigError,
    RevisionConflict,
    build_admin_catalog,
    load_config_snapshot,
    save_sku_config,
    seller_config_for_sku,
    validate_update,
)


class AdminConfigTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.paths = {
            "labels": root / "product_labels.json",
            "taxonomy": root / "product_variations.json",
            "cogs": root / "product_costs.json",
        }
        self.documents = {
            "labels": {
                "_meta": {"keep": "labels"},
                "KEEP": {"name": "Unrelated"},
                "SKU-1": {"name": "Old", "unknown": "preserve"},
            },
            "taxonomy": {
                "_meta": {"keep": "taxonomy"},
                "dimension_map": {"color": "design"},
                "value_map": {"design": {"Raw": "Mapped"}},
                "products": {
                    "KEEP": {"family_name": "Other", "attributes": {"format": "Other"}},
                    "SKU-1": {
                        "family_name": "Old family",
                        "attributes": {"design": "Old design"},
                        "unknown": "preserve",
                    },
                },
            },
            "cogs": {
                "_meta": {"currency": "MXN", "keep": True},
                "costs": {
                    "KEEP": 12.5,
                    "SKU-1": {
                        "current": 20,
                        "history": [
                            {
                                "effective_from": "2026-01-01",
                                "effective_to": "2026-06-30",
                                "unit_cogs": 18,
                            }
                        ],
                        "unknown": "preserve",
                    },
                },
            },
        }
        for name, document in self.documents.items():
            self.paths[name].write_text(json.dumps(document, indent=2) + "\n")

    def tearDown(self):
        self.temporary.cleanup()

    def payload(self, revision, **overrides):
        payload = {
            "sku": "SKU-1",
            "expected_revision": revision,
            "label": {
                "name": "Short name",
                "image_url": "https://images.example.test/item.jpg",
                "amazon_url": "https://www.amazon.com.mx/dp/BTEST",
            },
            "taxonomy": {
                "family_name": "Seller family",
                "attributes": {"format": "Notebook", "design": "Nature"},
            },
            "cogs": {"unit_cogs": 22.34567},
        }
        payload.update(overrides)
        return payload

    def test_save_preserves_unknowns_unrelated_skus_and_cost_history(self):
        before = load_config_snapshot(self.paths)

        result = save_sku_config(
            self.payload(before["revision"]),
            editable_skus={"SKU-1"},
            paths=self.paths,
        )

        self.assertTrue(result["changed"])
        after = load_config_snapshot(self.paths)
        self.assertNotEqual(after["revision"], before["revision"])
        self.assertEqual(after["documents"]["labels"]["_meta"], {"keep": "labels"})
        self.assertEqual(after["documents"]["labels"]["KEEP"], {"name": "Unrelated"})
        self.assertEqual(after["documents"]["labels"]["SKU-1"]["unknown"], "preserve")
        self.assertEqual(after["documents"]["taxonomy"]["dimension_map"], {"color": "design"})
        self.assertEqual(after["documents"]["taxonomy"]["value_map"], {"design": {"Raw": "Mapped"}})
        self.assertEqual(after["documents"]["taxonomy"]["products"]["SKU-1"]["unknown"], "preserve")
        self.assertEqual(after["documents"]["cogs"]["costs"]["KEEP"], 12.5)
        cost = after["documents"]["cogs"]["costs"]["SKU-1"]
        self.assertEqual(cost["history"], self.documents["cogs"]["costs"]["SKU-1"]["history"])
        self.assertEqual(cost["unknown"], "preserve")
        self.assertNotIn("current", cost)
        self.assertEqual(cost["unit_cogs"], 22.3457)
        self.assertEqual(seller_config_for_sku(after["documents"], "SKU-1")["cogs"]["unit_cogs"], 22.3457)
        self.assertTrue((self.paths["labels"].parent / "admin-audit.jsonl").is_file())
        for path in self.paths.values():
            self.assertTrue(list((path.parent / "backups").glob(f"{path.name}.*.bak")))

    def test_zero_is_valid_and_blank_clears_only_owned_fields(self):
        before = load_config_snapshot(self.paths)
        zero = self.payload(before["revision"])
        zero["cogs"] = {"unit_cogs": 0}
        saved = save_sku_config(zero, editable_skus={"SKU-1"}, paths=self.paths)
        self.assertEqual(saved["config"]["cogs"]["unit_cogs"], 0)

        clear = self.payload(saved["revision"])
        clear["label"] = {"name": "", "image_url": None, "amazon_url": ""}
        clear["taxonomy"] = {"family_name": None, "attributes": {}}
        clear["cogs"] = {"unit_cogs": None}
        cleared = save_sku_config(clear, editable_skus={"SKU-1"}, paths=self.paths)
        documents = load_config_snapshot(self.paths)["documents"]
        self.assertEqual(documents["labels"]["SKU-1"], {"unknown": "preserve"})
        self.assertEqual(documents["taxonomy"]["products"]["SKU-1"], {"unknown": "preserve"})
        self.assertEqual(
            documents["cogs"]["costs"]["SKU-1"],
            {"history": self.documents["cogs"]["costs"]["SKU-1"]["history"], "unknown": "preserve"},
        )
        self.assertIsNone(cleared["config"]["cogs"]["unit_cogs"])
        self.assertTrue(cleared["config"]["cogs"]["has_history"])

    def test_noop_does_not_write_backups_or_audit(self):
        snapshot = load_config_snapshot(self.paths)
        existing = seller_config_for_sku(snapshot["documents"], "SKU-1")
        payload = {
            "sku": "SKU-1",
            "expected_revision": snapshot["revision"],
            "label": existing["label"],
            "taxonomy": existing["taxonomy"],
            "cogs": {"unit_cogs": existing["cogs"]["unit_cogs"]},
        }
        result = save_sku_config(payload, editable_skus={"SKU-1"}, paths=self.paths)
        self.assertFalse(result["changed"])
        self.assertFalse((self.paths["labels"].parent / "backups").exists())
        self.assertFalse((self.paths["labels"].parent / "admin-audit.jsonl").exists())

    def test_stale_revision_and_non_current_sku_are_rejected(self):
        with self.assertRaises(RevisionConflict):
            save_sku_config(self.payload("0" * 64), editable_skus={"SKU-1"}, paths=self.paths)
        revision = load_config_snapshot(self.paths)["revision"]
        with self.assertRaises(AdminConfigError):
            save_sku_config(self.payload(revision), editable_skus={"OTHER"}, paths=self.paths)

    def test_validation_rejects_negative_cost_insecure_url_and_duplicate_dimensions(self):
        revision = load_config_snapshot(self.paths)["revision"]
        negative = self.payload(revision)
        negative["cogs"] = {"unit_cogs": -0.01}
        with self.assertRaises(AdminConfigError):
            validate_update(negative)
        insecure = self.payload(revision)
        insecure["label"]["image_url"] = "http://example.test/item.jpg"
        with self.assertRaises(AdminConfigError):
            validate_update(insecure)
        duplicate = self.payload(revision)
        duplicate["taxonomy"]["attributes"] = {"Design": "One", "design": "Two"}
        with self.assertRaises(AdminConfigError):
            validate_update(duplicate)

    def test_staging_failure_leaves_every_document_unchanged(self):
        before = {name: path.read_bytes() for name, path in self.paths.items()}
        revision = load_config_snapshot(self.paths)["revision"]
        from admin_config import _write_temp as real_write_temp

        calls = 0

        def fail_second(path, body):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("simulated staging failure")
            return real_write_temp(path, body)

        with patch("admin_config._write_temp", side_effect=fail_second):
            with self.assertRaises(OSError):
                save_sku_config(self.payload(revision), editable_skus={"SKU-1"}, paths=self.paths)
        self.assertEqual({name: path.read_bytes() for name, path in self.paths.items()}, before)

    def test_catalog_lifecycle_prepopulates_current_and_retains_deleted_read_only(self):
        snapshot = load_config_snapshot(self.paths)
        catalog = {
            "products": [
                {
                    "sku": "SKU-1",
                    "asin": "BCURRENT",
                    "catalog_title": "Amazon source title",
                    "product": "Old",
                    "product_role": "SELLABLE_VARIATION",
                    "catalog_membership": "CURRENT_OFFER",
                    "is_current_listing": True,
                    "amazon_variation_attributes": {"color_name": "Nature"},
                    "available": 4,
                    "inbound": 2,
                },
                {
                    "sku": "PARENT",
                    "product_role": "STRUCTURAL_PARENT",
                    "catalog_membership": "CURRENT_PARENT",
                },
            ],
            "deleted_products": [
                {"sku": "KEEP", "asin": "BOLD", "catalog_title": "Deleted title", "deleted_at": "2026-08-01"}
            ],
        }

        payload = build_admin_catalog(catalog, snapshot)

        self.assertEqual([row["sku"] for row in payload["current_products"]], ["SKU-1"])
        current = payload["current_products"][0]
        self.assertEqual(current["source_title"], "Amazon source title")
        self.assertEqual(current["amazon_variation_attributes"], {"color_name": "Nature"})
        self.assertEqual(current["lifecycle"], "CURRENT")
        self.assertEqual(payload["deleted_products"][0]["lifecycle"], "DELETED_HISTORY")
        self.assertEqual(payload["deleted_products"][0]["config"]["label"]["name"], "Unrelated")


if __name__ == "__main__":
    unittest.main()
