from __future__ import annotations

"""Canonical Advertising V2 economic contract.

This module owns economic arithmetic and eligibility. Callers provide source
operands; templates and browser code receive the resulting immutable-shaped
contract and must not recalculate contribution, state, or break-even values.
"""

from datetime import date, datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from hashlib import sha256
import json
from typing import Any, Literal, Mapping, TypedDict


CONTRACT_VERSION = "ads-economics-v1"
MONEY_QUANTUM = Decimal("0.0001")
RECONCILIATION_TOLERANCE = Decimal("0.01")

EconomicState = Literal["UNAVAILABLE", "INCOMPLETE", "PROVISIONAL", "RECONCILED", "CLOSED"]
EconomicScope = Literal["BUSINESS", "PRODUCT"]
PeriodState = Literal["CURRENT", "FINAL", "CLOSED"]
AdvertisingBasis = Literal["ADS_ANALYTICAL_SPEND", "FINANCE_ADVERTISING_EXPENSE"]


class EconomicPeriod(TypedDict):
    start_date: str
    end_date: str
    state: PeriodState
    timezone: str


class EconomicReconciliation(TypedDict):
    gross_sales_identity_delta: str | None
    accounting_identity_delta: str | None
    allocation_residual: str
    source_reconciliation_passed: bool | None
    allocation_state: str
    tolerance: str


class EconomicMetrics(TypedDict):
    contribution_before_ads: str | None
    contribution_after_ads: str | None
    contribution_margin_after_ads: str | None
    advertising_headroom: str | None


class EconomicContract(TypedDict):
    contract_version: str
    scope: EconomicScope
    identity: dict[str, str]
    period: EconomicPeriod
    basis: dict[str, Any]
    state: EconomicState
    authoritative: bool
    prescriptive_use: str
    qualification: str
    included_inputs: list[str]
    missing_inputs: list[str]
    operands: dict[str, str | int | None]
    reconciliation: EconomicReconciliation
    metrics: EconomicMetrics
    break_even: dict[str, str] | None
    fact_fingerprint: str


REQUIRED_BASE_INPUTS = (
    "gross_seller_sales_incl_iva",
    "iva_on_sales",
    "net_seller_sales_ex_iva",
    "units",
    "product_cogs",
    "amazon_selling_fees",
    "fulfillment_fees",
    "returns_refunds",
    "other_amazon_postings",
)

REQUIRED_BASIS_FIELDS = (
    "currency",
    "tax_basis",
    "sales_source",
    "sales_grain",
    "finance_source",
    "finance_grain",
    "advertising_source",
    "advertising_grain",
    "attribution_basis",
    "freshness_at",
)


def _decimal(value: Any, *, name: str) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, bool):
        raise ValueError(f"{name} must be numeric or null")
    try:
        result = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be numeric or null") from exc
    if not result.is_finite():
        raise ValueError(f"{name} must be finite")
    return result.quantize(MONEY_QUANTUM, rounding=ROUND_HALF_UP)


def _money(value: Decimal | None) -> str | None:
    return None if value is None else format(value.quantize(MONEY_QUANTUM), "f")


def _day(value: date | datetime | str, *, name: str) -> str:
    text = value.date().isoformat() if isinstance(value, datetime) else str(value)
    try:
        return date.fromisoformat(text[:10]).isoformat()
    except ValueError as exc:
        raise ValueError(f"{name} must be an ISO date") from exc


def _fingerprint(payload: Mapping[str, Any]) -> str:
    material = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return sha256(material.encode()).hexdigest()


def _qualification(state: EconomicState, missing: list[str], scope: EconomicScope) -> str:
    if state == "UNAVAILABLE":
        return "Required economic facts are unavailable; no contribution or capital-allocation claim is allowed."
    if state == "INCOMPLETE":
        detail = ", ".join(missing) if missing else "source or allocation reconciliation"
        subject = "Product" if scope == "PRODUCT" else "Business"
        return f"{subject} economics are incomplete ({detail}); observation is allowed, prescriptive use is blocked."
    if state == "PROVISIONAL":
        return "The current-period identity reconciles but can restate; use only as a guardrail for a bounded test."
    if state == "RECONCILED":
        return "The selected operating window and included allocations reconcile on the declared basis."
    return "This immutable Finance close is available for calibration, historical evaluation, and reporting."


def build_economic_contract(
    *,
    scope: EconomicScope,
    identity: Mapping[str, Any],
    period_start: date | datetime | str,
    period_end: date | datetime | str,
    period_state: PeriodState,
    basis: Mapping[str, Any],
    operands: Mapping[str, Any],
    advertising_basis: AdvertisingBasis,
    allocation_residual: Any = 0,
    source_reconciliation_passed: bool | None,
    declared_contribution_after_ads: Any = None,
) -> EconomicContract:
    """Build one exact, deterministic business or product economic contract.

    Fees, refunds and other Amazon postings use their signed Finance direction.
    Product COGS and Ads analytical spend are positive expense magnitudes.
    Finance advertising expense is a signed (normally negative) posting.
    """

    if scope not in {"BUSINESS", "PRODUCT"}:
        raise ValueError("scope must be BUSINESS or PRODUCT")
    if period_state not in {"CURRENT", "FINAL", "CLOSED"}:
        raise ValueError("period_state must be CURRENT, FINAL, or CLOSED")
    if advertising_basis not in {"ADS_ANALYTICAL_SPEND", "FINANCE_ADVERTISING_EXPENSE"}:
        raise ValueError("unsupported advertising_basis")
    missing_basis = [name for name in REQUIRED_BASIS_FIELDS if not basis.get(name)]
    if missing_basis:
        raise ValueError(f"basis is missing required fields: {', '.join(missing_basis)}")

    start = _day(period_start, name="period_start")
    end = _day(period_end, name="period_end")
    if start > end:
        raise ValueError("period_start must not be after period_end")
    normalized_identity = {
        str(key): str(value)
        for key, value in sorted(identity.items())
        if value is not None and str(value).strip()
    }
    if not normalized_identity:
        raise ValueError("identity must contain at least one non-empty field")

    required = [
        *REQUIRED_BASE_INPUTS,
        "ads_analytical_spend"
        if advertising_basis == "ADS_ANALYTICAL_SPEND"
        else "finance_advertising_expense",
    ]
    normalized: dict[str, Decimal | int | None] = {}
    for name in required:
        value = operands.get(name)
        if name == "units":
            if value is None:
                normalized[name] = None
            elif isinstance(value, bool) or int(value) != float(value) or int(value) < 0:
                raise ValueError("units must be a non-negative integer or null")
            else:
                normalized[name] = int(value)
        else:
            normalized[name] = _decimal(value, name=name)

    product_cogs = normalized["product_cogs"]
    analytical_spend = normalized.get("ads_analytical_spend")
    finance_advertising = normalized.get("finance_advertising_expense")
    if isinstance(product_cogs, Decimal) and product_cogs < 0:
        raise ValueError("product_cogs must be a positive expense magnitude")
    if isinstance(analytical_spend, Decimal) and analytical_spend < 0:
        raise ValueError("ads_analytical_spend must be a positive expense magnitude")
    if isinstance(finance_advertising, Decimal) and finance_advertising > 0:
        raise ValueError("finance_advertising_expense must use signed Finance direction")

    residual = _decimal(allocation_residual, name="allocation_residual") or Decimal(0)
    declared = _decimal(declared_contribution_after_ads, name="declared_contribution_after_ads")
    missing = [name for name in required if normalized.get(name) is None]
    included = [name for name in required if normalized.get(name) is not None]

    gross = normalized["gross_seller_sales_incl_iva"]
    iva = normalized["iva_on_sales"]
    net = normalized["net_seller_sales_ex_iva"]
    gross_delta = None
    before = after = margin = accounting_delta = None
    if all(isinstance(value, Decimal) for value in (gross, iva, net)):
        gross_delta = gross - net - iva  # type: ignore[operator]

    arithmetic_names = (
        "net_seller_sales_ex_iva",
        "product_cogs",
        "amazon_selling_fees",
        "fulfillment_fees",
        "returns_refunds",
        "other_amazon_postings",
    )
    if not any(name in missing for name in arithmetic_names):
        before = (
            normalized["net_seller_sales_ex_iva"]
            - normalized["product_cogs"]
            + normalized["amazon_selling_fees"]
            + normalized["fulfillment_fees"]
            + normalized["returns_refunds"]
            + normalized["other_amazon_postings"]
        )  # type: ignore[operator]
        ad_effect = (
            -normalized["ads_analytical_spend"]
            if advertising_basis == "ADS_ANALYTICAL_SPEND"
            else normalized["finance_advertising_expense"]
        )
        if isinstance(ad_effect, Decimal):
            after = before + ad_effect
            if isinstance(net, Decimal) and net != 0:
                margin = after / net
            if declared is not None:
                accounting_delta = declared - after

    has_facts = bool(included)
    identity_ok = gross_delta is not None and abs(gross_delta) <= RECONCILIATION_TOLERANCE
    accounting_ok = accounting_delta is None or abs(accounting_delta) <= RECONCILIATION_TOLERANCE
    product_allocation_ok = scope == "BUSINESS" or abs(residual) <= RECONCILIATION_TOLERANCE
    reconciliation_ok = (
        source_reconciliation_passed is True
        and identity_ok
        and accounting_ok
        and product_allocation_ok
    )
    if not has_facts:
        state: EconomicState = "UNAVAILABLE"
    elif missing or not reconciliation_ok:
        state = "INCOMPLETE"
    elif period_state == "CLOSED":
        state = "CLOSED"
    elif period_state == "FINAL":
        state = "RECONCILED"
    else:
        state = "PROVISIONAL"

    if source_reconciliation_passed is not True:
        missing.append("source_reconciliation")
    if not identity_ok:
        missing.append("gross_sales_identity")
    if not accounting_ok:
        missing.append("accounting_identity")
    if not product_allocation_ok:
        missing.append("product_allocation")
    missing = sorted(set(missing))

    authoritative = state in {"RECONCILED", "CLOSED"}
    prescriptive_use = {
        "UNAVAILABLE": "NONE",
        "INCOMPLETE": "OBSERVATION_ONLY",
        "PROVISIONAL": "GUARDRAIL_AND_BOUNDED_TEST_ONLY",
        "RECONCILED": "APPROVED_OPERATING_RULES_ONLY",
        "CLOSED": "CALIBRATION_AND_EVALUATION_ONLY",
    }[state]
    visible_before = before if state in {"PROVISIONAL", "RECONCILED", "CLOSED"} else None
    visible_after = after if state in {"PROVISIONAL", "RECONCILED", "CLOSED"} else None
    visible_margin = margin if state in {"PROVISIONAL", "RECONCILED", "CLOSED"} else None
    headroom = max(before, Decimal(0)) if authoritative and before is not None else None
    break_even = (
        {
            "maximum_observed_contribution_pool_before_ads": _money(before),
            "observed_advertising_headroom": _money(headroom),
            "qualification": "Observed same-period economics; not a marginal-response or incrementality estimate.",
        }
        if authoritative and before is not None and headroom is not None
        else None
    )

    serialized_operands: dict[str, str | int | None] = {}
    for name in required:
        value = normalized.get(name)
        serialized_operands[name] = value if isinstance(value, int) else _money(value)
    if declared is not None:
        serialized_operands["declared_contribution_after_ads"] = _money(declared)

    contract_without_fingerprint: dict[str, Any] = {
        "contract_version": CONTRACT_VERSION,
        "scope": scope,
        "identity": normalized_identity,
        "period": {
            "start_date": start,
            "end_date": end,
            "state": period_state,
            "timezone": str(basis.get("timezone") or "America/Mexico_City"),
        },
        "basis": dict(basis),
        "state": state,
        "authoritative": authoritative,
        "prescriptive_use": prescriptive_use,
        "qualification": _qualification(state, missing, scope),
        "included_inputs": included,
        "missing_inputs": missing,
        "operands": serialized_operands,
        "reconciliation": {
            "gross_sales_identity_delta": _money(gross_delta),
            "accounting_identity_delta": _money(accounting_delta),
            "allocation_residual": _money(residual),
            "source_reconciliation_passed": source_reconciliation_passed,
            "allocation_state": (
                "RECONCILED"
                if abs(residual) <= RECONCILIATION_TOLERANCE
                else "RESIDUAL_PRESERVED" if scope == "BUSINESS" else "INCOMPLETE"
            ),
            "tolerance": _money(RECONCILIATION_TOLERANCE),
        },
        "metrics": {
            "contribution_before_ads": _money(visible_before),
            "contribution_after_ads": _money(visible_after),
            "contribution_margin_after_ads": _money(visible_margin),
            "advertising_headroom": _money(headroom),
        },
        "break_even": break_even,
    }
    return {  # type: ignore[return-value]
        **contract_without_fingerprint,
        "fact_fingerprint": _fingerprint(contract_without_fingerprint),
    }


def validate_economic_contract(contract: Mapping[str, Any]) -> None:
    """Reject a contract that could bypass the canonical safety guarantees."""

    if contract.get("contract_version") != CONTRACT_VERSION:
        raise ValueError("unsupported economic contract version")
    state = contract.get("state")
    if state not in {"UNAVAILABLE", "INCOMPLETE", "PROVISIONAL", "RECONCILED", "CLOSED"}:
        raise ValueError("invalid economic state")
    authoritative = bool(contract.get("authoritative"))
    if authoritative != (state in {"RECONCILED", "CLOSED"}):
        raise ValueError("authoritative flag conflicts with economic state")
    missing = list(contract.get("missing_inputs") or [])
    if state in {"PROVISIONAL", "RECONCILED", "CLOSED"} and missing:
        raise ValueError("ready economic states cannot contain missing inputs")
    reconciliation = contract.get("reconciliation") or {}
    residual = _decimal(reconciliation.get("allocation_residual"), name="allocation_residual")
    if (
        contract.get("scope") == "PRODUCT"
        and state in {"PROVISIONAL", "RECONCILED", "CLOSED"}
        and residual is not None
        and abs(residual) > RECONCILIATION_TOLERANCE
    ):
        raise ValueError("product economics cannot be ready with an allocation residual")
    if contract.get("break_even") is not None and state not in {"RECONCILED", "CLOSED"}:
        raise ValueError("break-even values require reconciled or closed economics")
    supplied = dict(contract)
    fingerprint = supplied.pop("fact_fingerprint", None)
    if not fingerprint or fingerprint != _fingerprint(supplied):
        raise ValueError("economic contract fingerprint mismatch")
