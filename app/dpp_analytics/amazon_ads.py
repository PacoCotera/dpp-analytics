from __future__ import annotations

import gzip
import io
import json
import logging
import time
from datetime import date, datetime, timedelta, timezone
from typing import Any

import httpx

from . import db
from .settings import settings

log = logging.getLogger("dpp.amazon_ads")

LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token"
SOURCE = "amazon_ads"
JOB = "sponsored_products_reporting_v3"
AD_PRODUCT = "SPONSORED_PRODUCTS"
# Sponsored Products seller conversion metrics use the seller attribution window.
# Amazon's current reporting definitions describe that as 7 days for sellers.
ATTRIBUTION_WINDOW = "7d_seller_click"
# Advertised-product reporting has a 90-day lookback. Use the common denominator
# for campaign + product ingestion so all grains reconcile over the same dates.
MAX_BACKFILL_DAYS = 90


def _num(row: dict[str, Any], *names: str) -> float:
    for name in names:
        value = row.get(name)
        if value not in (None, ""):
            try:
                return float(value)
            except (TypeError, ValueError):
                pass
    return 0.0


def _int(row: dict[str, Any], *names: str) -> int:
    return int(round(_num(row, *names)))


def _json(value: Any) -> str:
    return json.dumps(value, default=str, separators=(",", ":"))


class AmazonAdsClient:
    """Read-only Amazon Ads client for account discovery and Reporting v3.

    The warehouse is transport-neutral. Amazon Ads API v1 unified reporting is
    the long-term reporting direction, while Reporting v3 remains supported and
    gives us the seller campaign/product facts needed today.
    """

    def __init__(self) -> None:
        self.base = settings.ads_api_endpoint
        self.client = httpx.Client(timeout=45.0, follow_redirects=True)
        self._token: str | None = None

    def close(self) -> None:
        self.client.close()

    def access_token(self) -> str:
        if self._token:
            return self._token
        response = self.client.post(
            LWA_TOKEN_URL,
            data={
                "grant_type": "refresh_token",
                "refresh_token": settings.ads_refresh_token,
                "client_id": settings.ads_client_id,
                "client_secret": settings.ads_client_secret,
            },
        )
        response.raise_for_status()
        body = response.json()
        token = body.get("access_token")
        if not token:
            raise RuntimeError(f"Amazon Ads LWA response did not contain access_token: {body}")
        self._token = str(token)
        return self._token

    def headers(
        self,
        scope: str | None = None,
        *,
        content_type: str = "application/json",
        accept: str = "application/json",
    ) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self.access_token()}",
            "Amazon-Advertising-API-ClientId": settings.ads_client_id,
            "Content-Type": content_type,
            "Accept": accept,
        }
        if scope:
            headers["Amazon-Advertising-API-Scope"] = str(scope)
        return headers

    def discover_advertiser_accounts(self) -> dict[str, Any]:
        response = self.client.post(
            f"{self.base}/adsApi/v1/query/advertiserAccounts",
            headers=self.headers(),
            json={},
        )
        response.raise_for_status()
        return response.json()

    def discover_legacy_profiles(self) -> list[dict[str, Any]]:
        """Compatibility bridge for Reporting v3 scope/profile IDs."""
        response = self.client.get(f"{self.base}/v2/profiles", headers=self.headers())
        response.raise_for_status()
        body = response.json()
        return [x for x in body if isinstance(x, dict)] if isinstance(body, list) else []

    def create_report(self, scope: str, start: date, end: date, *, grain: str) -> str:
        common = ["date", "campaignId", "campaignName", "impressions", "clicks", "cost"]
        seller_conversions = ["purchases7d", "sales7d", "unitsSoldClicks7d"]
        if grain == "campaign":
            configuration = {
                "adProduct": AD_PRODUCT,
                "groupBy": ["campaign"],
                "columns": common[:3] + ["campaignStatus"] + common[3:] + seller_conversions,
                "reportTypeId": "spCampaigns",
                "timeUnit": "DAILY",
                "format": "GZIP_JSON",
            }
        elif grain == "product":
            configuration = {
                "adProduct": AD_PRODUCT,
                "groupBy": ["advertiser"],
                "columns": common[:3] + ["adGroupId", "advertisedSku", "advertisedAsin"] + common[3:] + seller_conversions,
                "reportTypeId": "spAdvertisedProduct",
                "timeUnit": "DAILY",
                "format": "GZIP_JSON",
            }
        else:
            raise ValueError(f"unsupported Ads report grain: {grain}")

        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        payload = {
            "name": f"dpp-{grain}-{start.isoformat()}-{end.isoformat()}-{stamp}",
            "startDate": start.isoformat(),
            "endDate": end.isoformat(),
            "configuration": configuration,
        }
        response = self.client.post(
            f"{self.base}/reporting/reports",
            headers=self.headers(
                scope,
                content_type="application/vnd.createasyncreportrequest.v3+json",
                accept="application/vnd.createasyncreportresponse.v3+json",
            ),
            json=payload,
        )
        response.raise_for_status()
        body = response.json()
        report_id = body.get("reportId") or body.get("report_id")
        if not report_id:
            raise RuntimeError(f"Amazon Ads createReport returned no reportId: {body}")
        return str(report_id)

    def wait_for_report(self, scope: str, report_id: str) -> dict[str, Any]:
        deadline = time.monotonic() + settings.ads_report_poll_timeout_seconds
        while time.monotonic() < deadline:
            response = self.client.get(
                f"{self.base}/reporting/reports/{report_id}",
                headers=self.headers(
                    scope,
                    accept="application/vnd.getasyncreportresponse.v3+json",
                ),
            )
            response.raise_for_status()
            body = response.json()
            status = str(body.get("status") or "").upper()
            if status in {"COMPLETED", "SUCCESS"}:
                return body
            if status in {"FAILURE", "FAILED", "CANCELLED"}:
                raise RuntimeError(f"Amazon Ads report {report_id} ended with status={status}: {body}")
            time.sleep(settings.ads_report_poll_seconds)
        raise TimeoutError(f"Amazon Ads report {report_id} did not complete within timeout")

    def download_report(self, location: str) -> list[dict[str, Any]]:
        # Download URLs are pre-signed. Do not send advertising authorization headers.
        response = self.client.get(location)
        response.raise_for_status()
        raw = response.content
        if raw[:2] == b"\x1f\x8b":
            raw = gzip.GzipFile(fileobj=io.BytesIO(raw)).read()
        text = raw.decode("utf-8-sig").strip()
        if not text:
            return []
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                return [r for r in parsed if isinstance(r, dict)]
            if isinstance(parsed, dict):
                for key in ("rows", "data", "records"):
                    rows = parsed.get(key)
                    if isinstance(rows, list):
                        return [r for r in rows if isinstance(r, dict)]
                return [parsed]
        except json.JSONDecodeError:
            pass
        rows: list[dict[str, Any]] = []
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            value = json.loads(line)
            if isinstance(value, dict):
                rows.append(value)
        return rows


def _walk_records(value: Any) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    if isinstance(value, list):
        for item in value:
            found.extend(_walk_records(item))
    elif isinstance(value, dict):
        if any(k in value for k in ("advertiserAccountId", "profileId", "accountId")):
            found.append(value)
        for child in value.values():
            if isinstance(child, (dict, list)):
                found.extend(_walk_records(child))
    unique: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in found:
        marker = _json(row)
        if marker not in seen:
            seen.add(marker)
            unique.append(row)
    return unique


def _profile_ids_from_account(row: dict[str, Any]) -> list[str]:
    ids: list[str] = []
    direct = row.get("profileId") or row.get("profile_id")
    if direct:
        ids.append(str(direct))
    for key in ("alternateIds", "alternateIdentifiers", "countryAccounts", "marketplaceAccounts", "accounts"):
        value = row.get(key)
        if isinstance(value, list):
            for item in value:
                if not isinstance(item, dict):
                    continue
                profile = item.get("profileId") or item.get("profile_id")
                country = str(item.get("countryCode") or item.get("country") or "").upper()
                marketplace = str(item.get("marketplaceId") or "")
                if profile and (not country or country == "MX" or marketplace == settings.marketplace_id):
                    ids.append(str(profile))
    return list(dict.fromkeys(ids))


def _upsert_account(profile: str, row: dict[str, Any]) -> None:
    country = str(row.get("countryCode") or row.get("country") or "MX")[:2].upper() or "MX"
    currency = str(row.get("currencyCode") or row.get("currency") or "MXN")[:3].upper() or "MXN"
    account_info = row.get("accountInfo") if isinstance(row.get("accountInfo"), dict) else {}
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO ads.account(account_id, marketplace_id, country_code, currency, timezone,
                                    account_name, account_type, status, last_discovered_at, metadata)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,now(),%s::jsonb)
            ON CONFLICT(account_id) DO UPDATE SET
                marketplace_id=COALESCE(EXCLUDED.marketplace_id, ads.account.marketplace_id),
                country_code=COALESCE(EXCLUDED.country_code, ads.account.country_code),
                currency=COALESCE(EXCLUDED.currency, ads.account.currency),
                timezone=COALESCE(EXCLUDED.timezone, ads.account.timezone),
                account_name=COALESCE(EXCLUDED.account_name, ads.account.account_name),
                account_type=COALESCE(EXCLUDED.account_type, ads.account.account_type),
                status=COALESCE(EXCLUDED.status, ads.account.status),
                last_discovered_at=now(), metadata=EXCLUDED.metadata
            """,
            (
                profile,
                settings.marketplace_id if country == "MX" else None,
                country,
                currency,
                row.get("timezone") or row.get("timeZone"),
                row.get("name") or row.get("accountName") or row.get("advertiserName") or account_info.get("name"),
                row.get("accountType") or row.get("type") or account_info.get("type"),
                row.get("status") or row.get("state"),
                _json(row),
            ),
        )
        conn.commit()


def discover_scopes(client: AmazonAdsClient) -> tuple[list[str], dict[str, Any]]:
    if settings.ads_account_ids:
        scopes = list(settings.ads_account_ids)
        for scope in scopes:
            _upsert_account(scope, {"countryCode": "MX", "currencyCode": "MXN", "source": "configured"})
        return scopes, {"source": "configured", "profiles": len(scopes)}

    payload = client.discover_advertiser_accounts()
    records = _walk_records(payload)
    scopes: list[str] = []
    for row in records:
        for profile in _profile_ids_from_account(row):
            scopes.append(profile)
            _upsert_account(profile, row)

    # Reporting v3 still commonly scopes sponsored-ads requests with profile IDs.
    # If the new global-account envelope does not expose an alternate profile ID,
    # bridge through the established profile listing endpoint.
    legacy_profiles = 0
    if not scopes:
        profiles = client.discover_legacy_profiles()
        legacy_profiles = len(profiles)
        for row in profiles:
            country = str(row.get("countryCode") or "").upper()
            profile = row.get("profileId")
            if profile and (not country or country == "MX"):
                scopes.append(str(profile))
                _upsert_account(str(profile), row)

    scopes = list(dict.fromkeys(scopes))
    return scopes, {
        "source": "advertiser_accounts_v1" if scopes and not legacy_profiles else "profiles_v2_fallback",
        "advertiser_records": len(records),
        "legacy_profiles_seen": legacy_profiles,
        "profiles": len(scopes),
    }


def _ensure_account(scope: str) -> None:
    _upsert_account(scope, {"countryCode": "MX", "currencyCode": "MXN", "source": "reporting_scope"})


def _write_campaign_rows(scope: str, rows: list[dict[str, Any]], report_id: str) -> int:
    written = 0
    with db.connect() as conn, conn.cursor() as cur:
        for row in rows:
            campaign_id = str(row.get("campaignId") or "")
            business_date = row.get("date")
            if not campaign_id or not business_date:
                continue
            cur.execute(
                """
                INSERT INTO ads.campaign(account_id,campaign_id,ad_product,campaign_name,state,last_seen_at,metadata)
                VALUES (%s,%s,%s,%s,%s,now(),%s::jsonb)
                ON CONFLICT(account_id,campaign_id) DO UPDATE SET
                    campaign_name=COALESCE(EXCLUDED.campaign_name,ads.campaign.campaign_name),
                    state=COALESCE(EXCLUDED.state,ads.campaign.state),last_seen_at=now(),metadata=EXCLUDED.metadata
                """,
                (scope, campaign_id, AD_PRODUCT, row.get("campaignName"), row.get("campaignStatus"), _json(row)),
            )
            cur.execute(
                """
                INSERT INTO ads.daily_campaign(account_id,campaign_id,business_date,ad_product,impressions,clicks,spend,
                    attributed_sales,purchases,units,currency,attribution_method,attribution_window,source_report_id,source_generated_at,ingested_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'MXN','click',%s,%s,now(),now())
                ON CONFLICT(account_id,campaign_id,business_date) DO UPDATE SET
                    impressions=EXCLUDED.impressions,clicks=EXCLUDED.clicks,spend=EXCLUDED.spend,
                    attributed_sales=EXCLUDED.attributed_sales,purchases=EXCLUDED.purchases,units=EXCLUDED.units,
                    attribution_method=EXCLUDED.attribution_method,attribution_window=EXCLUDED.attribution_window,
                    source_report_id=EXCLUDED.source_report_id,source_generated_at=EXCLUDED.source_generated_at,ingested_at=now()
                """,
                (
                    scope, campaign_id, business_date, AD_PRODUCT,
                    _int(row, "impressions"), _int(row, "clicks"), _num(row, "cost", "spend"),
                    _num(row, "sales7d", "sales"), _int(row, "purchases7d", "purchases"),
                    _int(row, "unitsSoldClicks7d", "unitsSold7d", "units"), ATTRIBUTION_WINDOW, report_id,
                ),
            )
            written += 1
        conn.commit()
    return written


def _write_product_rows(scope: str, rows: list[dict[str, Any]], report_id: str) -> int:
    written = 0
    with db.connect() as conn, conn.cursor() as cur:
        for row in rows:
            campaign_id = str(row.get("campaignId") or "")
            business_date = row.get("date")
            if not campaign_id or not business_date:
                continue
            cur.execute(
                """
                INSERT INTO ads.campaign(account_id,campaign_id,ad_product,campaign_name,last_seen_at,metadata)
                VALUES (%s,%s,%s,%s,now(),%s::jsonb)
                ON CONFLICT(account_id,campaign_id) DO UPDATE SET
                    campaign_name=COALESCE(EXCLUDED.campaign_name,ads.campaign.campaign_name),last_seen_at=now()
                """,
                (scope, campaign_id, AD_PRODUCT, row.get("campaignName"), _json({"source": "advertised_product_report"})),
            )
            cur.execute(
                """
                INSERT INTO ads.daily_advertised_product(account_id,business_date,ad_product,campaign_id,ad_group_id,
                    advertised_sku,advertised_asin,impressions,clicks,spend,attributed_sales,purchases,units,currency,
                    attribution_method,attribution_window,source_report_id,source_generated_at,ingested_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'MXN','click',%s,%s,now(),now())
                ON CONFLICT(account_id,business_date,ad_product,campaign_id,ad_group_id,advertised_sku,advertised_asin)
                DO UPDATE SET impressions=EXCLUDED.impressions,clicks=EXCLUDED.clicks,spend=EXCLUDED.spend,
                    attributed_sales=EXCLUDED.attributed_sales,purchases=EXCLUDED.purchases,units=EXCLUDED.units,
                    attribution_method=EXCLUDED.attribution_method,attribution_window=EXCLUDED.attribution_window,
                    source_report_id=EXCLUDED.source_report_id,source_generated_at=EXCLUDED.source_generated_at,ingested_at=now()
                """,
                (
                    scope, business_date, AD_PRODUCT, campaign_id, str(row.get("adGroupId") or ""),
                    str(row.get("advertisedSku") or ""), str(row.get("advertisedAsin") or ""),
                    _int(row, "impressions"), _int(row, "clicks"), _num(row, "cost", "spend"),
                    _num(row, "sales7d", "sales"), _int(row, "purchases7d", "purchases"),
                    _int(row, "unitsSoldClicks7d", "unitsSold7d", "units"), ATTRIBUTION_WINDOW, report_id,
                ),
            )
            written += 1
        conn.commit()
    return written


def _refresh_daily_account(scope: str, start: date, end: date) -> None:
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO ads.daily_account(account_id,business_date,ad_product,impressions,clicks,spend,attributed_sales,
                purchases,units,currency,attribution_method,attribution_window,source_generated_at,ingested_at)
            SELECT account_id,business_date,%s,sum(impressions),sum(clicks),sum(spend),
                   sum(attributed_sales),sum(purchases),sum(units),'MXN','click',%s,max(source_generated_at),now()
            FROM ads.daily_campaign
            WHERE account_id=%s AND business_date BETWEEN %s AND %s
            GROUP BY account_id,business_date
            ON CONFLICT(account_id,business_date,ad_product) DO UPDATE SET
                impressions=EXCLUDED.impressions,clicks=EXCLUDED.clicks,spend=EXCLUDED.spend,
                attributed_sales=EXCLUDED.attributed_sales,purchases=EXCLUDED.purchases,units=EXCLUDED.units,
                attribution_method=EXCLUDED.attribution_method,attribution_window=EXCLUDED.attribution_window,
                source_generated_at=EXCLUDED.source_generated_at,ingested_at=now()
            """,
            (AD_PRODUCT, ATTRIBUTION_WINDOW, scope, start, end),
        )
        conn.commit()


def _next_window() -> tuple[date, date]:
    yesterday = date.today() - timedelta(days=1)
    earliest = max(
        date(2025, 10, 1),
        date.today() - timedelta(days=min(settings.ads_backfill_days, MAX_BACKFILL_DAYS)),
    )
    cursor = db.get_cursor(SOURCE, JOB, "through_date")
    if cursor:
        start = max(earliest, date.fromisoformat(cursor) + timedelta(days=1))
    else:
        start = earliest
    if start > yesterday:
        # Conversion attribution can revise. Re-pull the recent complete window.
        start = max(earliest, yesterday - timedelta(days=13))
    end = min(yesterday, start + timedelta(days=30))
    return start, end


def probe_ads() -> dict[str, Any]:
    if not settings.ads_enabled:
        return {"status": "disabled", "credentials_present": settings.ads_credentials_present}
    if not settings.ads_credentials_present:
        return {"status": "missing_credentials", "credentials_present": False}
    client = AmazonAdsClient()
    try:
        scopes, meta = discover_scopes(client)
        return {
            "status": "ok" if scopes else "no_mx_profiles",
            "credentials_present": True,
            "scopes": scopes,
            **meta,
        }
    finally:
        client.close()


def ingest_ads() -> dict[str, Any]:
    if not settings.ads_enabled:
        return {"status": "disabled"}
    if not settings.ads_credentials_present:
        return {"status": "missing_credentials"}

    start, end = _next_window()
    client = AmazonAdsClient()
    try:
        scopes, discovery = discover_scopes(client)
        if not scopes:
            return {"status": "no_mx_profiles", "window": [start.isoformat(), end.isoformat()], **discovery}

        with db.ingestion_run(SOURCE, JOB, {"start": start.isoformat(), "end": end.isoformat(), **discovery}) as run:
            total_read = 0
            total_written = 0
            report_ids: list[str] = []
            for scope in scopes:
                _ensure_account(scope)
                for grain, writer in (("campaign", _write_campaign_rows), ("product", _write_product_rows)):
                    report_id = client.create_report(scope, start, end, grain=grain)
                    report_ids.append(report_id)
                    status = client.wait_for_report(scope, report_id)
                    location = status.get("url") or status.get("location")
                    if not location:
                        raise RuntimeError(f"Amazon Ads report {report_id} completed without download URL: {status}")
                    rows = client.download_report(str(location))
                    total_read += len(rows)
                    total_written += writer(scope, rows, report_id)
                _refresh_daily_account(scope, start, end)
            run["records_read"] = total_read
            run["records_written"] = total_written

        db.set_cursor(SOURCE, JOB, end.isoformat(), "through_date")
        return {
            "status": "success",
            "start": start.isoformat(),
            "end": end.isoformat(),
            "accounts": len(scopes),
            "records_read": total_read,
            "records_written": total_written,
            "report_ids": report_ids,
            "attribution_window": ATTRIBUTION_WINDOW,
        }
    finally:
        client.close()
