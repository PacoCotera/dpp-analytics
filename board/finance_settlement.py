from __future__ import annotations

from datetime import date, datetime


_MONTHS = (
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
)


def _short_date(value) -> str | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        value = value.date()
    if isinstance(value, date):
        return f"{_MONTHS[value.month - 1]} {value.day}"
    text = str(value).strip()
    try:
        parsed = date.fromisoformat(text[:10])
    except ValueError:
        return text
    return f"{_MONTHS[parsed.month - 1]} {parsed.day}"


def settlement_display_contract(
    settlement_id,
    report_id,
    settlement_start_date,
    settlement_end_date,
    deposit_date,
) -> dict:
    """Return stable identifiers and explicit date availability for one settlement."""
    start = _short_date(settlement_start_date)
    end = _short_date(settlement_end_date)
    deposit = _short_date(deposit_date)
    known_dates = sum(value is not None for value in (start, end, deposit))
    date_state = "UNKNOWN" if known_dates == 0 else "KNOWN" if known_dates == 3 else "PARTIAL"

    if start and end:
        period_label = f"{start}–{end} settlement"
        period_state = "KNOWN"
    elif start:
        period_label = f"Settlement from {start} · end date unknown"
        period_state = "PARTIAL"
    elif end:
        period_label = f"Settlement through {end} · start date unknown"
        period_state = "PARTIAL"
    else:
        period_label = "Settlement dates unknown"
        period_state = "UNKNOWN"

    identity_parts = []
    if settlement_id not in (None, ""):
        identity_parts.append(f"Settlement {settlement_id}")
    if report_id not in (None, ""):
        identity_parts.append(f"report {report_id}")

    return {
        "date_state": date_state,
        "identity_label": " · ".join(identity_parts) or "Settlement identity unavailable",
        "period_state": period_state,
        "period_label": period_label,
        "deposit_state": "KNOWN" if deposit else "UNKNOWN",
        "deposit_label": f"Deposit {deposit}" if deposit else "Deposit date unknown",
    }
