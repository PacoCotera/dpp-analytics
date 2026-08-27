from __future__ import annotations

import unittest

from finance_emergency import (
    _aggregate_closed_months,
    _closed_bridge_delta,
    _closed_bridge_total,
)


def closed_month(
    *,
    sales: float,
    amazon_effect: float,
    other_postings: float,
    advertising: float,
    product_cogs: float,
    contribution: float,
) -> dict:
    row = {
        "net_sales_ex_vat": sales,
        "shopper_product_spend": sales * 1.16,
        "amazon_order_effect": amazon_effect,
        "other_amazon_postings": other_postings,
        "advertising": advertising,
        "product_cogs": product_cogs,
        "cash_transferred": 0,
    }
    row["contribution_after_product_cogs"] = contribution
    return row


BRIDGE_CASES = [
    closed_month(
        sales=1000,
        amazon_effect=-180,
        other_postings=125.25,
        advertising=-90,
        product_cogs=300,
        contribution=555.25,
    ),
    closed_month(
        sales=100,
        amazon_effect=-80,
        other_postings=-42.75,
        advertising=-75,
        product_cogs=50,
        contribution=-147.75,
    ),
    closed_month(
        sales=500,
        amazon_effect=-100,
        other_postings=0,
        advertising=-100,
        product_cogs=300,
        contribution=0,
    ),
]


class FinanceReconciliationTest(unittest.TestCase):
    def test_closed_months_reconcile_with_positive_negative_and_zero_other_postings(self):
        for row in BRIDGE_CASES:
            with self.subTest(other_postings=row["other_amazon_postings"]):
                self.assertEqual(_closed_bridge_delta(row), 0)

    def test_cent_rounding_is_stable(self):
        row = closed_month(
            sales=14653.06,
            amazon_effect=-2746.01,
            other_postings=-265.15,
            advertising=-8576.29,
            product_cogs=3950,
            contribution=-884.39,
        )

        self.assertEqual(_closed_bridge_total(row), -884.39)
        self.assertEqual(_closed_bridge_delta(row), 0)

    def test_half_cent_inputs_round_to_api_cents_before_reconciliation(self):
        row = closed_month(
            sales=10.005,
            amazon_effect=-0.005,
            other_postings=0.004,
            advertising=-0.004,
            product_cogs=0.005,
            contribution=9.99,
        )

        self.assertEqual(_closed_bridge_total(row), 9.99)
        self.assertEqual(_closed_bridge_delta(row), 0)

    def test_ytd_aggregate_includes_every_operand_and_reconciles(self):
        ytd = _aggregate_closed_months(BRIDGE_CASES)

        self.assertEqual(ytd["months"], 3)
        self.assertEqual(ytd["other_amazon_postings"], 82.5)
        self.assertEqual(_closed_bridge_delta(ytd), 0)

    def test_zero_sales_ytd_has_no_margin_and_still_reconciles(self):
        ytd = _aggregate_closed_months(
            [
                closed_month(
                    sales=0,
                    amazon_effect=0,
                    other_postings=0,
                    advertising=0,
                    product_cogs=0,
                    contribution=0,
                )
            ]
        )

        self.assertIsNone(ytd["contribution_margin_pct"])
        self.assertEqual(_closed_bridge_delta(ytd), 0)


if __name__ == "__main__":
    unittest.main()
