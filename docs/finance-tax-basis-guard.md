# Finance tax-basis production gate

DPP Mexico production reconciliation established that Amazon Sales & Traffic `orderedProductSales` is shopper-facing product spend **including IVA**. Finance is the accounting boundary that removes IVA.

For marketplace policy `SHOPPER_SPEND_INCL_TAX`, every OPEN/finalizing period and every immutable CLOSED/RESTATED snapshot must satisfy, within cent rounding:

- `gross customer spend = Amazon Sales & Traffic orderedProductSales`
- `net sales ex IVA = gross customer spend / (1 + marketplace VAT rate)`
- `IVA withheld = gross customer spend - net sales ex IVA`
- `gross customer spend = net sales ex IVA + IVA withheld`

Amazon payout remains a separate settlement-cash measure after tax withholding and Amazon deductions. It is not used to define revenue.

## Enforcement

The contract is enforced in three independent layers:

1. `board/finance_api_corrected.py` translates the reconciled gross operating source into Finance net/IVA/gross fields for OPEN and finalizing periods.
2. `core.validate_finance_close_insert()` rejects future immutable closes whose stored net/IVA/gross arithmetic disagrees with marketplace tax policy. Historical corrections append RESTATED versions rather than modifying prior versions.
3. `dpp_analytics.finance_basis_audit` independently compares the deployed Finance API with production warehouse Sales & Traffic totals and the latest immutable close rows. The chained Production Number Audit fails if this check fails.

A deployment is not Finance-certified merely because the page renders or because `net + IVA = gross` internally. The gross source must also independently reconcile to production Sales & Traffic, and every latest immutable close must carry the corrected tax-basis marker and an explicit reason when RESTATED.
