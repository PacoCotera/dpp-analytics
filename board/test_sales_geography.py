from __future__ import annotations

import unittest
from decimal import Decimal

from sales_geography_api import (
    _canonical_coverage,
    _canonical_product_analysis,
    _canonicalize_rows,
)


REFERENCES = [
    {
        "postal_code": "01180",
        "state_code": "09",
        "state_name": "Ciudad de México",
    },
    {
        "postal_code": "11500",
        "state_code": "09",
        "state_name": "Ciudad de México",
    },
    {
        "postal_code": "54715",
        "state_code": "15",
        "state_name": "Estado de México",
    },
    {
        "postal_code": "55029",
        "state_code": "15",
        "state_name": "Estado de México",
    },
]


def row(state: str, postal: str, *, sales: str = "100.00", orders: int = 1, units: int = 1):
    return {
        "business_date": "2026-08-01",
        "country_code": "MX",
        "state_or_region": state,
        "postal_code": postal,
        "sales": Decimal(sales),
        "orders": orders,
        "units": units,
        "aov": Decimal(sales),
    }


class CanonicalGeographyTests(unittest.TestCase):
    def test_cdmx_variants_resolve_to_one_federal_entity_before_aggregation(self):
        canonical, resolution = _canonicalize_rows(
            [
                row("CDMX", "01180", sales="100.00"),
                row("D.F.", "01180", sales="200.00"),
                row("Mexico City", "11500", sales="300.00"),
                row("Ciudad de México", "11500", sales="400.00"),
            ],
            REFERENCES,
        )

        self.assertEqual({item["state_code"] for item in canonical}, {"09"})
        self.assertEqual({item["state_name"] for item in canonical}, {"Ciudad de México"})
        self.assertEqual(len(canonical), 2)  # one row per canonical date + postal grain
        self.assertEqual(sum(item["sales"] for item in canonical), Decimal("1000.00"))
        self.assertEqual(resolution["resolved_orders"], 4)
        self.assertEqual(resolution["alias_resolved_orders"], 3)

    def test_estado_de_mexico_variants_resolve_by_postal_reference(self):
        canonical, resolution = _canonicalize_rows(
            [
                row("MEXICO", "55029", sales="199.00"),
                row("Estado de Mexico", "54715", sales="279.00"),
                row("Estado de México", "54715", sales="21.00"),
            ],
            REFERENCES,
        )

        self.assertEqual({item["state_code"] for item in canonical}, {"15"})
        self.assertEqual({item["state_or_region"] for item in canonical}, {"Estado de México"})
        self.assertEqual(sum(item["orders"] for item in canonical), 3)
        self.assertEqual(sum(item["sales"] for item in canonical), Decimal("499.00"))
        self.assertEqual(resolution["alias_resolved_orders"], 1)

    def test_unreferenced_postal_orders_are_reported_not_raw_bucketed(self):
        canonical, resolution = _canonicalize_rows(
            [row("Tlalpan", "99999", orders=2, units=2)],
            REFERENCES,
        )
        coverage = _canonical_coverage(
            {
                "orders_total": 5,
                "orders_with_postal": 2,
                "states": 1,
            },
            resolution,
        )

        self.assertEqual(canonical, [])
        self.assertEqual(coverage["canonical_states"], 0)
        self.assertEqual(coverage["unmapped_orders"], 5)
        self.assertEqual(coverage["unmapped_postal_orders"], 2)
        self.assertEqual(coverage["alias_resolution_pct"], 0.0)
        self.assertEqual(coverage["raw_state_labels"], 1)

    def test_coverage_separates_canonical_unmapped_and_alias_resolution(self):
        canonical, resolution = _canonicalize_rows(
            [
                row("CDMX", "01180", orders=2, units=2),
                row("Estado de México", "54715"),
            ],
            REFERENCES,
        )
        coverage = _canonical_coverage(
            {
                "orders_total": 4,
                "orders_with_postal": 3,
                "states": 3,
            },
            resolution,
        )

        self.assertEqual(len(canonical), 2)
        self.assertEqual(coverage["canonical_states"], 2)
        self.assertEqual(coverage["states"], 2)
        self.assertEqual(coverage["raw_state_labels"], 3)
        self.assertEqual(coverage["resolved_state_orders"], 3)
        self.assertEqual(coverage["unmapped_orders"], 1)
        self.assertEqual(coverage["alias_resolved_orders"], 2)
        self.assertEqual(coverage["alias_resolution_pct"], 100.0)

    def test_sku_dimensions_remain_separate_after_state_normalization(self):
        rows = [
            {**row("CDMX", "01180"), "seller_sku": "A", "asin": "ASIN-A"},
            {**row("D.F.", "01180"), "seller_sku": "B", "asin": "ASIN-B"},
        ]
        canonical, _ = _canonicalize_rows(
            rows,
            REFERENCES,
            dimensions=("seller_sku", "asin"),
        )

        self.assertEqual(len(canonical), 2)
        self.assertEqual({item["seller_sku"] for item in canonical}, {"A", "B"})
        self.assertTrue(all(item["state_code"] == "09" for item in canonical))


class CanonicalGeographyProductTests(unittest.TestCase):
    def setUp(self):
        self.current = [
            {
                "sku": "PNC-001",
                "asin": "B0CURRENT",
                "product": "Current pencil",
                "status": "Active",
                "product_role": "SELLABLE_VARIATION",
                "catalog_membership": "CURRENT_OFFER",
            },
            {
                "sku": "PNC-NEW",
                "asin": "B0NEW",
                "product": "New pencil",
                "status": "Inactive",
                "product_role": "SELLABLE_STANDALONE",
                "catalog_membership": "CURRENT_OFFER",
            },
        ]
        self.sources = [
            {"sku": "PNC-001", "asin": "B0CURRENT", "product": "Current pencil"},
            {"sku": "PNC-001-FBM", "asin": "B0CURRENT", "product": "Old FBM offer"},
            {"sku": "OLD-001", "asin": "B0OLD", "product": "Historical pencil"},
        ]

    @staticmethod
    def fact(sku: str, asin: str, sales: str = "100.00") -> dict:
        return {
            "business_date": "2026-08-01",
            "seller_sku": sku,
            "asin": asin,
            "sales": Decimal(sales),
            "orders": 1,
            "units": 1,
        }

    def test_alias_sharing_current_asin_rolls_into_canonical_offer(self):
        rows, products, contract = _canonical_product_analysis(
            [
                self.fact("PNC-001", "B0CURRENT"),
                self.fact("PNC-001-FBM", "B0CURRENT"),
            ],
            self.current,
            self.sources,
        )

        self.assertEqual({item["analysis_sku"] for item in rows}, {"PNC-001"})
        alias = next(item for item in rows if item["seller_sku"] == "PNC-001-FBM")
        self.assertEqual(alias["source_sku"], "PNC-001-FBM")
        self.assertTrue(alias["is_alias"])
        self.assertNotIn("PNC-001-FBM", {item["sku"] for item in products})
        canonical = next(item for item in products if item["sku"] == "PNC-001")
        self.assertEqual(canonical["source_skus"], ["PNC-001", "PNC-001-FBM"])
        self.assertEqual(contract["collapsed_alias_source_skus"], 1)

    def test_current_zero_evidence_and_inactive_offer_remains_explicit(self):
        _, products, contract = _canonical_product_analysis(
            [self.fact("PNC-001", "B0CURRENT")],
            self.current,
            self.sources,
        )

        new_offer = next(item for item in products if item["sku"] == "PNC-NEW")
        self.assertTrue(new_offer["is_current_offer"])
        self.assertFalse(new_offer["is_active_offer"])
        self.assertEqual(new_offer["source_skus"], [])
        self.assertEqual(contract["current_offers"], 2)
        self.assertEqual(contract["active_current_offers"], 1)

    def test_historical_product_is_separate_without_reviving_catalog_membership(self):
        rows, products, contract = _canonical_product_analysis(
            [self.fact("OLD-001", "B0OLD", "0.00")],
            self.current,
            self.sources,
        )

        historical = next(item for item in products if item["sku"] == "OLD-001")
        self.assertFalse(historical["is_current_offer"])
        self.assertFalse(historical["is_active_offer"])
        self.assertEqual(historical["catalog_membership"], "HISTORICAL_RECORD")
        self.assertEqual(rows[0]["analysis_sku"], "OLD-001")
        self.assertEqual(rows[0]["source_sku"], "OLD-001")
        self.assertFalse(rows[0]["is_alias"])
        self.assertEqual(contract["historical_products"], 1)

    def test_missing_asin_uses_exact_current_sku_without_alias_inference(self):
        rows, products, _ = _canonical_product_analysis(
            [self.fact("PNC-001", "")],
            self.current,
            self.sources,
        )

        self.assertEqual(rows[0]["analysis_sku"], "PNC-001")
        self.assertEqual(rows[0]["catalog_membership"], "CURRENT_OFFER")
        self.assertFalse(rows[0]["is_alias"])
        self.assertEqual(len([item for item in products if item["sku"] == "PNC-001"]), 1)


if __name__ == "__main__":
    unittest.main()
