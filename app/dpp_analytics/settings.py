from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    db_host: str = os.getenv("DB_HOST", "postgres")
    db_port: int = int(os.getenv("DB_PORT", "5432"))
    db_name: str = os.getenv("POSTGRES_DB", "dpp")
    db_user: str = os.getenv("POSTGRES_USER", "dpp")
    db_password: str = os.getenv("POSTGRES_PASSWORD", "")

    marketplace_id: str = os.getenv("SPAPI_MARKETPLACE_ID", "A1AM78C64UM0Y8")
    spapi_endpoint: str = os.getenv("SPAPI_ENDPOINT", "https://sellingpartnerapi-na.amazon.com")
    lwa_client_id: str = os.getenv("SPAPI_LWA_CLIENT_ID", "")
    lwa_client_secret: str = os.getenv("SPAPI_LWA_CLIENT_SECRET", "")
    lwa_refresh_token: str = os.getenv("SPAPI_LWA_REFRESH_TOKEN", "")
    spapi_enabled: bool = os.getenv("SPAPI_ENABLED", "false").lower() in {"1", "true", "yes", "on"}

    orders_interval_seconds: int = int(os.getenv("ORDERS_INTERVAL_SECONDS", "600"))
    inventory_interval_seconds: int = int(os.getenv("INVENTORY_INTERVAL_SECONDS", "1800"))
    finances_interval_seconds: int = int(os.getenv("FINANCES_INTERVAL_SECONDS", "14400"))
    scheduler_tick_seconds: int = int(os.getenv("SCHEDULER_TICK_SECONDS", "15"))

    user_agent: str = os.getenv(
        "SPAPI_USER_AGENT",
        "DirtyPawzPressAnalytics/0.1 (Language=Python/3.13)",
    )

    @property
    def spapi_credentials_present(self) -> bool:
        return bool(self.lwa_client_id and self.lwa_client_secret and self.lwa_refresh_token)


settings = Settings()
