import copy
import unittest

from ads_economics import build_economic_contract, validate_economic_contract


READY = {
    "gross_seller_sales_incl_iva": "1160",
    "iva_on_sales": "160",
    "net_seller_sales_ex_iva": "1000",
    "units": 10,
    "product_cogs": "300",
    "amazon_selling_fees": "-120",
    "fulfillment_fees": "-80",
    "returns_refunds": "-50",
    "other_amazon_postings": "10",
    "ads_analytical_spend": "100",
}


def contract(**changes):
    values = {
        "scope": "PRODUCT",
        "identity": {"marketplace_id": "A1AM78C64UM0Y8", "sku": "SKU-1"},
        "period_start": "2026-08-01",
        "period_end": "2026-08-28",
        "period_state": "FINAL",
        "basis": {
            "currency": "MXN",
            "tax_basis": "NET_SALES_EX_IVA",
            "sales_source": "Amazon Sales & Traffic",
            "sales_grain": "CHILD_ASIN_DAY",
            "finance_source": "Finances API v2024",
            "finance_grain": "TRANSACTION_ITEM_POSTED_DAY",
            "advertising_source": "Amazon Ads",
            "advertising_grain": "ADVERTISED_PRODUCT_DAY",
            "attribution_basis": "Amazon attributed response is not incrementality",
            "freshness_at": "2026-08-29T06:00:00Z",
        },
        "operands": READY,
        "advertising_basis": "ADS_ANALYTICAL_SPEND",
        "allocation_residual": 0,
        "source_reconciliation_passed": True,
    }
    values.update(changes)
    return build_economic_contract(**values)


class EconomicContractTests(unittest.TestCase):
    def test_exact_operating_identity_and_break_even(self):
        result = contract()
        self.assertEqual(result["state"], "RECONCILED")
        self.assertEqual(result["metrics"]["contribution_before_ads"], "460.0000")
        self.assertEqual(result["metrics"]["contribution_after_ads"], "360.0000")
        self.assertEqual(result["metrics"]["contribution_margin_after_ads"], "0.3600")
        self.assertEqual(result["break_even"]["observed_advertising_headroom"], "460.0000")
        validate_economic_contract(result)

    def test_missing_cogs_blocks_product_economics(self):
        inputs = {**READY, "product_cogs": None}
        result = contract(operands=inputs)
        self.assertEqual(result["state"], "INCOMPLETE")
        self.assertFalse(result["authoritative"])
        self.assertIn("product_cogs", result["missing_inputs"])
        self.assertIsNone(result["break_even"])

    def test_product_residual_blocks_but_business_residual_is_preserved(self):
        product = contract(allocation_residual="12.34")
        self.assertEqual(product["state"], "INCOMPLETE")
        self.assertEqual(product["reconciliation"]["allocation_state"], "INCOMPLETE")
        self.assertIsNone(product["metrics"]["contribution_after_ads"])
        business = contract(scope="BUSINESS", identity={"marketplace_id": "MX"}, allocation_residual="12.34")
        self.assertEqual(business["state"], "RECONCILED")
        self.assertEqual(business["reconciliation"]["allocation_state"], "RESIDUAL_PRESERVED")

    def test_current_reconciled_window_is_only_provisional(self):
        result = contract(period_state="CURRENT")
        self.assertEqual(result["state"], "PROVISIONAL")
        self.assertFalse(result["authoritative"])
        self.assertIsNone(result["break_even"])

    def test_closed_contract_uses_signed_finance_advertising(self):
        inputs = dict(READY)
        inputs.pop("ads_analytical_spend")
        inputs["finance_advertising_expense"] = "-100"
        result = contract(
            scope="BUSINESS",
            period_state="CLOSED",
            operands=inputs,
            advertising_basis="FINANCE_ADVERTISING_EXPENSE",
        )
        self.assertEqual(result["state"], "CLOSED")
        self.assertEqual(result["metrics"]["contribution_after_ads"], "360.0000")
        self.assertEqual(result["prescriptive_use"], "CALIBRATION_AND_EVALUATION_ONLY")

    def test_sales_identity_mismatch_never_reconciles(self):
        result = contract(operands={**READY, "gross_seller_sales_incl_iva": "1159"})
        self.assertEqual(result["state"], "INCOMPLETE")
        self.assertIn("gross_sales_identity", result["missing_inputs"])

    def test_declared_accounting_identity_is_checked(self):
        result = contract(declared_contribution_after_ads="359")
        self.assertEqual(result["state"], "INCOMPLETE")
        self.assertEqual(result["reconciliation"]["accounting_identity_delta"], "-1.0000")

    def test_fingerprint_is_deterministic_and_tampering_is_rejected(self):
        first = contract()
        second = contract(identity={"sku": "SKU-1", "marketplace_id": "A1AM78C64UM0Y8"})
        self.assertEqual(first["fact_fingerprint"], second["fact_fingerprint"])
        tampered = copy.deepcopy(first)
        tampered["metrics"]["contribution_after_ads"] = "999.0000"
        with self.assertRaisesRegex(ValueError, "fingerprint"):
            validate_economic_contract(tampered)

    def test_invalid_signs_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "positive expense"):
            contract(operands={**READY, "ads_analytical_spend": -1})


if __name__ == "__main__":
    unittest.main()
