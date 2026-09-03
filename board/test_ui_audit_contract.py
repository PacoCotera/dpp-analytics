import unittest

from inventory_api import _decorate_inventory_rows
from product_api import _ads_product_identity


class UiAuditIdentityContractTest(unittest.TestCase):
    def test_inventory_ads_actions_receive_decorated_product_identity(self):
        source = {
            "sku": "SKU-1",
            "asin": "ASIN-1",
            "product": "Long marketplace title with raw listing evidence",
            "available": 4,
        }

        def decorate(rows):
            return [{**row, "product": "Seller short name"} for row in rows]

        rows = _decorate_inventory_rows(
            [source],
            [{"sku": "SKU-1", "asin": "ASIN-1"}],
            set(),
            decorate,
        )

        self.assertEqual(rows[0]["product"], "Seller short name")
        self.assertEqual(rows[0]["inventory_lifecycle"], "CURRENT_OFFER")
        self.assertTrue(rows[0]["is_default_inventory"])

    def test_product_ads_context_receives_decorated_product_identity(self):
        def decorate(rows):
            return [
                {
                    **row,
                    "product": "Seller short name",
                    "image_url": "https://example.test/canonical.webp",
                }
                for row in rows
            ]

        identity = _ads_product_identity(
            decorate,
            "SKU-1",
            "ASIN-1",
            "Long marketplace title with raw listing evidence",
            "https://example.test/raw.webp",
        )

        self.assertEqual(identity["product"], "Seller short name")
        self.assertEqual(
            identity["image_url"], "https://example.test/canonical.webp"
        )


if __name__ == "__main__":
    unittest.main()
