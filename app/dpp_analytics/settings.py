from __future__ import annotations

import os
from dataclasses import dataclass


def _bool(name: str, default: str = "false") -> bool:
    return os.getenv(name, default).strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    db_host: str = os.getenv("DB_HOST", "postgres")
    db_port: int = int(os.getenv("DB_PORT", "5432"))
    db_name: str = os.getenv("POSTGRES_DB", "dpp")
    db_user: str = os.getenv("POSTGRES_USER", "dpp")
    db_password: str = os.getenv("POSTGRES_PASSWORD", "")

    marketplace_id: str = os.getenv("SPAPI_MARKETPLACE_ID", "A1AM78C64UM0Y8")
    spapi_environment: str = os.getenv("SPAPI_ENVIRONMENT", "sandbox").strip().lower()
    spapi_endpoint_override: str = os.getenv("SPAPI_ENDPOINT", "").strip()
    lwa_client_id: str = os.getenv("SPAPI_LWA_CLIENT_ID", "")
    lwa_client_secret: str = os.getenv("SPAPI_LWA_CLIENT_SECRET", "")
    lwa_refresh_token: str = os.getenv("SPAPI_LWA_REFRESH_TOKEN", "")
    spapi_enabled: bool = _bool("SPAPI_ENABLED")

    # Amazon Ads is a separate authorization surface from SP-API. Keep its credentials
    # and account identity independent so the warehouse can support multiple advertisers
    # and marketplaces later. API v1 unified reporting is the forward reporting path.
    ads_enabled: bool = _bool("AMAZON_ADS_ENABLED")
    ads_client_id: str = os.getenv("AMAZON_ADS_CLIENT_ID", "")
    ads_client_secret: str = os.getenv("AMAZON_ADS_CLIENT_SECRET", "")
    ads_refresh_token: str = os.getenv("AMAZON_ADS_REFRESH_TOKEN", "")
    ads_account_ids: tuple[str, ...] = tuple(
        x.strip() for x in os.getenv("AMAZON_ADS_ACCOUNT_IDS", "").split(",") if x.strip()
    )
    ads_api_endpoint: str = os.getenv("AMAZON_ADS_API_ENDPOINT", "https://advertising-api.amazon.com").rstrip("/")
    ads_reporting_interval_seconds: int = int(os.getenv("AMAZON_ADS_REPORTING_INTERVAL_SECONDS", "21600"))
    # Sponsored Products advertised-product reporting currently exposes a 90-day lookback.
    ads_backfill_days: int = int(os.getenv("AMAZON_ADS_BACKFILL_DAYS", "90"))
    ads_report_poll_seconds: int = int(os.getenv("AMAZON_ADS_REPORT_POLL_SECONDS", "5"))
    ads_report_poll_timeout_seconds: int = int(os.getenv("AMAZON_ADS_REPORT_POLL_TIMEOUT_SECONDS", "300"))

    # Production is deliberately two-stage. We first prove the production credentials
    # and authorized roles with read-only calls. Historical/live ingestion is enabled
    # only after the smoke test succeeds and this explicit kill-switch is set true.
    production_ingestion_enabled: bool = _bool("SPAPI_PRODUCTION_INGESTION_ENABLED")

    # searchOrders v2026-01-01 has a low default steady-state rate limit. Three minutes
    # keeps the Today wall meaningfully live while respecting Amazon's documented default.
    orders_interval_seconds: int = int(os.getenv("ORDERS_INTERVAL_SECONDS", "180"))
    inventory_interval_seconds: int = int(os.getenv("INVENTORY_INTERVAL_SECONDS", "1800"))
    finances_interval_seconds: int = int(os.getenv("FINANCES_INTERVAL_SECONDS", "14400"))
    settlement_reports_interval_seconds: int = int(os.getenv("SETTLEMENT_REPORTS_INTERVAL_SECONDS", "21600"))
    data_kiosk_interval_seconds: int = int(os.getenv("DATA_KIOSK_INTERVAL_SECONDS", "43200"))
    listings_report_interval_seconds: int = int(os.getenv("LISTINGS_REPORT_INTERVAL_SECONDS", "21600"))
    reports_poll_seconds: int = int(os.getenv("REPORTS_POLL_SECONDS", "5"))
    reports_poll_timeout_seconds: int = int(os.getenv("REPORTS_POLL_TIMEOUT_SECONDS", "300"))
    catalog_enabled: bool = _bool("CATALOG_ENABLED")
    catalog_interval_seconds: int = int(os.getenv("CATALOG_INTERVAL_SECONDS", "86400"))
    data_kiosk_poll_seconds: int = int(os.getenv("DATA_KIOSK_POLL_SECONDS", "10"))
    data_kiosk_poll_timeout_seconds: int = int(os.getenv("DATA_KIOSK_POLL_TIMEOUT_SECONDS", "300"))
    sandbox_probe_interval_seconds: int = int(os.getenv("SANDBOX_PROBE_INTERVAL_SECONDS", "21600"))
    production_probe_interval_seconds: int = int(os.getenv("PRODUCTION_PROBE_INTERVAL_SECONDS", "21600"))
    scheduler_tick_seconds: int = int(os.getenv("SCHEDULER_TICK_SECONDS", "15"))

    user_agent: str = os.getenv(
        "SPAPI_USER_AGENT",
        "DirtyPawzPressAnalytics/0.1 (Language=Python/3.13)",
    )

    @property
    def is_sandbox(self) -> bool:
        return self.spapi_environment in {"sandbox", "test"}

    @property
    def is_production(self) -> bool:
        return self.spapi_environment in {"production", "prod"}

    @property
    def spapi_endpoint(self) -> str:
        if self.spapi_endpoint_override:
            return self.spapi_endpoint_override
        if self.is_sandbox:
            return "https://sandbox.sellingpartnerapi-na.amazon.com"
        return "https://sellingpartnerapi-na.amazon.com"

    @property
    def spapi_credentials_present(self) -> bool:
        return bool(self.lwa_client_id and self.lwa_client_secret and self.lwa_refresh_token)

    @property
    def ads_credentials_present(self) -> bool:
        return bool(self.ads_client_id and self.ads_client_secret and self.ads_refresh_token)


settings = Settings()
