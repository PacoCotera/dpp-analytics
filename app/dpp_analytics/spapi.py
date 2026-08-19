from __future__ import annotations

import datetime as dt
import random
import time
from typing import Any, Iterable

import httpx

from .settings import settings


class SpApiError(RuntimeError):
    pass


class SpApiClient:
    def __init__(self) -> None:
        self._access_token: str | None = None
        self._access_token_expires_at = 0.0
        self.http = httpx.Client(timeout=httpx.Timeout(45.0, connect=15.0))

    def close(self) -> None:
        self.http.close()

    def _token(self) -> str:
        if self._access_token and time.time() < self._access_token_expires_at - 120:
            return self._access_token

        if not settings.spapi_credentials_present:
            raise SpApiError("SP-API LWA credentials are not configured")

        response = self.http.post(
            "https://api.amazon.com/auth/o2/token",
            data={
                "grant_type": "refresh_token",
                "refresh_token": settings.lwa_refresh_token,
                "client_id": settings.lwa_client_id,
                "client_secret": settings.lwa_client_secret,
            },
            headers={"content-type": "application/x-www-form-urlencoded;charset=UTF-8"},
        )
        if response.status_code != 200:
            raise SpApiError(f"LWA token exchange failed: HTTP {response.status_code}: {response.text[:500]}")

        payload = response.json()
        self._access_token = payload["access_token"]
        self._access_token_expires_at = time.time() + int(payload.get("expires_in", 3600))
        return self._access_token

    def get(self, path: str, params: dict[str, Any] | Iterable[tuple[str, Any]] | None = None) -> dict[str, Any]:
        url = f"{settings.spapi_endpoint.rstrip('/')}/{path.lstrip('/')}"
        last_error: str | None = None

        for attempt in range(6):
            now = dt.datetime.now(dt.timezone.utc)
            headers = {
                "x-amz-access-token": self._token(),
                "x-amz-date": now.strftime("%Y%m%dT%H%M%SZ"),
                "user-agent": settings.user_agent,
                "accept": "application/json",
            }
            response = self.http.get(url, params=params, headers=headers)

            if response.status_code == 401 and attempt == 0:
                self._access_token = None
                self._access_token_expires_at = 0
                continue

            if response.status_code == 429 or 500 <= response.status_code < 600:
                last_error = f"HTTP {response.status_code}: {response.text[:500]}"
                retry_after = response.headers.get("retry-after")
                if retry_after:
                    try:
                        delay = float(retry_after)
                    except ValueError:
                        delay = 0.0
                else:
                    delay = 0.0
                delay = max(delay, min(60.0, (2 ** attempt) + random.random()))
                time.sleep(delay)
                continue

            if response.status_code >= 400:
                raise SpApiError(f"SP-API GET {path} failed: HTTP {response.status_code}: {response.text[:1000]}")

            return response.json()

        raise SpApiError(f"SP-API GET {path} exhausted retries: {last_error}")
