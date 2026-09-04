# Advertising V2 economics contract

**Status:** Batch 1 internal foundation. It does not authorize customer-facing
contribution recommendations.

## Ownership

- `mart.ads_business_economic_operands_daily` preserves business Sales & Traffic,
  the IVA transform, signed Finance postings, Ads analytical spend, Finance
  advertising expense, and allocation residuals as separate facts.
- `mart.ads_product_economic_operands_daily` preserves current offer-owner
  CHILD-ASIN sales, exact Finance item assignments, Ads product spend, and the
  business residual that can invalidate product economics.
- `board/ads_economics.py` alone derives economic state, contribution arithmetic,
  break-even availability, qualification, and the deterministic fact fingerprint.
- Templates, browser code, charts, exports, and future Advisory consumers must
  render this contract and must not recreate its arithmetic or eligibility.

## Accounting direction

The contract uses these signs:

- net seller sales ex IVA is positive;
- product COGS and Ads analytical spend are positive expense magnitudes;
- Amazon selling fees, fulfillment fees, refunds, Finance advertising expense,
  and other Finance postings retain their signed Finance direction.

For an operating Ads contract:

```text
net seller sales ex IVA
- product COGS
+ signed Amazon selling fees
+ signed fulfillment fees
+ signed returns/refunds
+ signed other Amazon postings
= contribution before ads
- Ads analytical spend
= contribution after ads
```

For an immutable Finance close, signed Finance advertising expense replaces Ads
analytical spend. The two advertising operands are never added together.

## Residual and state rules

- A business contract may be reconciled while retaining a non-zero product
  allocation residual because the residual remains visible in the business total.
- A product contract with a residual greater than the declared cent tolerance is
  `INCOMPLETE`.
- Missing COGS, fee operands, attribution relationships, or source reconciliation
  also force `INCOMPLETE`.
- A reconciled current period is `PROVISIONAL`; a finalized operating period is
  `RECONCILED`; an immutable Finance version is `CLOSED`.
- Break-even/headroom values are absent unless the state is `RECONCILED` or
  `CLOSED`. They describe observed same-period economics and are never a marginal
  response, causality, or incrementality estimate.

## Current limitation

Production Finance item evidence contains exact product relationships for many
Shipment, Refund, and reimbursement rows, but also unresolved identity, account-
level ServiceFee, Adjustment, miscellaneous-ledger, and advertising-payment
amounts. The warehouse views expose those gaps without proportional allocation.
Until COGS and every required category reconcile at product grain, Advertising V2
must keep product contribution and economic actions unavailable.
