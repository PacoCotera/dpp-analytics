from __future__ import annotations

"""Canonical finance-close entry point packaged as dpp_analytics.finance_close."""

from .finance_close_tax_corrected import close_ready_months, main, restate_month

__all__ = ["close_ready_months", "restate_month", "main"]


if __name__ == "__main__":
    main()
