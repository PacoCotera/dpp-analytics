from __future__ import annotations

import unittest
from decimal import Decimal

from sales_geography_api import _canonical_coverage, _canonicalize_rows


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


if __name__ == "__main__":
    unittest.main()
