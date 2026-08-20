from __future__ import annotations

import gzip
import io
import json
import logging
import time
from datetime import date, timedelta
from typing import Any

import httpx

from . import db
from .settings import settings

log = logging.getLogger("dpp.amazon_ads")

LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token"
SOURCE = "amazon_ads"
JOB = "sponsored_products_reporting_v3"


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


class AmazonAdsClient:
    """Small, read-only Amazon Ads client.

    Account discovery uses the current Advertiser Account API. Performance
    ingestion currently uses Reporting v3 because Amazon continues to support
    and extend it while the new cross-account v1 reporting API matures. The
    warehouse is deliberately API-version-neutral so the transport can be
    swapped without changing product semantics.
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
        self._token = response.json()["access_token"]
        return self._token

    def headers(self, scope: str | None = None, *, content_type: str = "application/json") -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self.access_token()}",
            "Amazon-Advertising-API-ClientId": settings.ads_client_id,
            "Content-Type": content_type,
        }
        if scope:
            headers["Amazon-Advertising-API-Scope"] = str(scope)
        return headers

    def discover_advertiser_accounts(self) -> dict[str, Any]:
        """Query the GA advertiser-account endpoint introduced in Ads API v1."""
        response = self.client.post(
            f"{self.base}/adsApi/v1/query/advertiserAccounts",
            headers=self.headers(),
            json={},
        )
        response.raise_for_status()
        return response.json()

    def create_report(self, scope: str, start: date, end: date, *, grain: str) -> str:
        if grain == "campaign":
            configuration = {
                "adProduct": "SPONSORED_PRODUCTS",
                "groupBy": ["campaign"],
                "columns": [
                    "date", "campaignId", "campaignName", "campaignStatus",
                    "impressions", "clicks", "cost", "purchases14d",
                    "sales14d", "unitsSoldClicks14d",
                ],
                "reportTypeId": "spCampaigns",
                "timeUnit": "DAILY",
                "format": "GZIP_JSON",
            }
        elif grain == "product":
            configuration = {
                "adProduct": "SPONSORED_PRODUCTS",
                "groupBy": ["advertiser"],
                "columns": [
                    "date", "campaignId", "campaignName", "adGroupId",
                    "advertisedSku", "advertisedAsin", "impressions", "clicks",
                    "cost", "purchases14d", "sales14d", "unitsSoldClicks14d",
                ],
                "reportTypeId": "spAdvertisedProduct",
                "timeUnit": "DAILY",
                "format": "GZIP_JSON",
            }
        else:
            raise ValueError(f"unsupported Ads report grain: {grain}")

        payload = {
            "name": f"dpp-{grain}-{start.isoformat()}-{end.isoformat()}",
            "startDate": start.isoformat(),
            "endDate": end.isoformat(),
            "configuration": configuration,
        }
        response = self.client.post(
            f"{self.base}/reporting/reports",
            headers=self.headers(
                scope,
                content_type="application/vnd.createasyncreportrequest.v3+json",
            ),
            json=payload,
        )
        if response.status_code == 425:
            raise RuntimeError("Amazon Ads rejected a duplicate report request (HTTP 425); retry on the next scheduler pass")
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
                    content_type="application/vnd.getasyncreportresponse.v3+json",
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
            if line:
                value = json.loads(line)
                if isinstance(value, dict):
                    rows.append(value)
        return rows


def _walk_records(value: Any) -> list[dict[str, Any]]:
    """Find account-like records without binding to one response envelope revision."""
    found: list[dict[str, Any]] = []
    if isinstance(value, list):
        for item in value:
            if isinstance(item, dict):
                if any(k in item for k in ("advertiserAccountId", "profileId", "accountId")):
                    found.append(item)
                else:
                    found.extend(_walk_records(item))
    elif isinstance(value, dict):
        if any(k in value for k in ("advertiserAccountId", "profileId", "accountId")):
            found.append(value)
        for child in value.values():
            if isinstance(child, (dict, list)):
                found.extend(_walk_records(child))
    # preserve first occurrence while avoiding nested duplicates
    unique: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in found:
        marker = json.dumps(row, sort_keys=True, default=str)
        if marker not in seen:
            seen.add(marker)
            unique.append(row)
    return unique


def _profile_ids_from_account(row: dict[str, Any]) -> list[str]:
    ids: list[str] = []
    direct = row.get("profileId") or row.get("profile_id")
    if direct:
        ids.append(str(direct))
    for key in ("alternateIds", "alternateIdentifiers", "countryAccounts", "marketplaceAccounts"):
        value = row.get(key)
        if isinstance(value, list):
            for item in value:
                if isinstance(item, dict):
                    profile = item.get("profileId") or item.get("profile_id") or item.get("id")
                    country = str(item.get("countryCode") or item.get("country") or "").upper()
                    marketplace = str(item.get("marketplaceId") or "")
                    if profile and (not country or country == "MX" or marketplace == settings.marketplace_id):
                        ids.append(str(profile))
    return list(dict.fromkeys(ids))


def discover_scopes(client: AmazonAdsClient) -> tuple[list[str], dict[str, Any]]:
    if settings.ads_account_ids:
        return list(settings.ads_account_ids), {"source": "configured", "accounts": list(settings.ads_account_ids)}
    payload = client.discover_advertiser_accounts()
    records = _walk_records(payload)
    scopes: list[str] = []
    with db.connect() as conn, conn.cursor() as cur:
        for row in records:
            global_id = str(row.get("advertiserAccountId") or row.get("accountId") or row.get("id") or "")
            profiles = _profile_ids_from_account(row)
            scopes.extend(profiles)
            for profile in profiles or ([global_id] if global_id else []):
                country = str(row.get("countryCode") or row.get("country") or "")[:2] or None
                currency = str(row.get("currencyCode") or row.get("currency") or "")[:3] or None
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
                        settings.marketplace_id if (country or "MX").upper() == "MX" else None,
                        country or "MX",
                        currency or "MXN",
                        row.get("timezone") or row.get("timeZone"),
                        row.get("name") or row.get("accountName") or row.get("advertiserName"),
                        row.get("accountType") or row.get("type"),
                        row.get("status") or row.get("state"),
                        json.dumps(row, default=str),
                    ),
                )
        conn.commit()
    scopes = list(dict.fromkeys(scopes))
    return scopes, {"source": "advertiser_accounts_v1", "records": len(records), "profiles": len(scopes)}


def _ensure_account(scope: str) -> None:
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO ads.account(account_id, marketplace_id, country_code, currency, metadata)
            VALUES (%s,%s,'MX','MXN','{}'::jsonb)
            ON CONFLICT(account_id) DO UPDATE SET marketplace_id=EXCLUDED.marketplace_id, last_discovered_at=now()
            """,
            (scope, settings.marketplace_id),
        )
        conn.commit()


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
                VALUES (%s,%s,'SPONSORED_PRODUCTS',%s,%s,now(),%s::jsonb)
                ON CONFLICT(account_id,campaign_id) DO UPDATE SET
                    campaign_name=COALESCE(EXCLUDED.campaign_name,ads.campaign.campaign_name),
                    state=COALESCE(EXCLUDED.state,ads.campaign.state),last_seen_at=now(),metadata=EXCLUDED.metadata
                """,
                (scope, campaign_id, row.get("campaignName"), row.get("campaignStatus"), json.dumps(row, default=str)),
            )
            cur.execute(
                """
                INSERT INTO ads.daily_campaign(account_id,campaign_id,business_date,ad_product,impressions,clicks,spend,
                    attributed_sales,purchases,units,currency,attribution_method,attribution_window,source_report_id,source_generated_at,ingested_at)
                VALUES (%s,%s,%s,'SPONSORED_PRODUCTS',%s,%s,%s,%s,%s,%s,'MXN','click','14d',%s,now(),now())
                ON CONFLICT(account_id,campaign_id,business_date) DO UPDATE SET
                    impressions=EXCLUDED.impressions,clicks=EXCLUDED.clicks,spend=EXCLUDED.spend,
                    attributed_sales=EXCLUDED.attributed_sales,purchases=EXCLUDED.purchases,units=EXCLUDED.units,
                    source_report_id=EXCLUDED.source_report_id,source_generated_at=EXCLUDED.source_generated_at,ingested_at=now()
                """,
                (
                    scope, campaign_id, business_date,
                    _int(row, "impressions"), _int(row, "clicks"), _num(row, "cost", "spend"),
                    _num(row, "sales14d", "sales"), _int(row, "purchases14d", "purchases"),
                    _int(row, "unitsSoldClicks14d", "unitsSold14d", "units"), report_id,
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
                VALUES (%s,%s,'SPONSORED_PRODUCTS',%s,now(),%s::jsonb)
                ON CONFLICT(account_id,campaign_id) DO UPDATE SET
                    campaign_name=COALESCE(EXCLUDED.campaign_name,ads.campaign.campaign_name),last_seen_at=now()
                """,
                (scope, campaign_id, row.get("campaignName"), json.dumps({"source": "advertised_product_report"})),
            )
            cur.execute(
                """
                INSERT INTO ads.daily_advertised_product(account_id,business_date,ad_product,campaign_id,ad_group_id,
                    advertised_sku,advertised_asin,impressions,clicks,spend,attributed_sales,purchases,units,currency,
                    attribution_method,attribution_window,source_report_id,source_generated_at,ingested_at)
                VALUES (%s,%s,'SPONSORED_PRODUCTS',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'MXN','click','14d',%s,now(),now())
                ON CONFLICT(account_id,business_date,ad_product,campaign_id,ad_group_id,advertised_sku,advertised_asin)
                DO UPDATE SET impressions=EXCLUDED.impressions,clicks=EXCLUDED.clicks,spend=EXCLUDED.spend,
                    attributed_sales=EXCLUDED.attributed_sales,purchases=EXCLUDED.purchases,units=EXCLUDED.units,
                    source_report_id=EXCLUDED.source_report_id,source_generated_at=EXCLUDED.source_generated_at,ingested_at=now()
                """,
                (
                    scope, business_date, campaign_id, str(row.get("adGroupId") or ""),
                    str(row.get("advertisedSku") or ""), str(row.get("advertisedAsin") or ""),
                    _int(row, "impressions"), _int(row, "clicks"), _num(row, "cost", "spend"),
                    _num(row, "sales14d", "sales"), _int(row, "purchases14d", "purchases"),
                    _int(row, "unitsSoldClicks14d", "unitsSold14d", "units"), report_id,
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
            SELECT account_id,business_date,'SPONSORED_PRODUCTS',sum(impressions),sum(clicks),sum(spend),
                   sum(attributed_sales),sum(purchases),sum(units),'MXN','click','14d',max(source_generated_at),now()
            FROM ads.daily_campaign
            WHERE account_id=%s AND business_date BETWEEN %s AND %s
            GROUP BY account_id,business_date
            ON CONFLICT(account_id,business_date,ad_product) DO UPDATE SET
                impressions=EXCLUDED.impressions,clicks=EXCLUDED.clicks,spend=EXCLUDED.spend,
                attributed_sales=EXCLUDED.attributed_sales,purchases=EXCLUDED.purchases,units=EXCLUDED.units,
                source_generated_at=EXCLUDED.source_generated_at,ingested_at=now()
            """,
            (scope, start, end),
        )
        conn.commit()


def _next_window() -> tuple[date, date]:
    yesterday = date.today() - timedelta(days=1)
    cursor = db.get_cursor(SOURCE, JOB, "through_date")
    if cursor:
        start = date.fromisoformat(cursor) + timedelta(days=1)
    else:
        start = max(date.today() - timedelta(days=settings.ads_backfill_days), date(2025, 10, 1))
    if start > yesterday:
        # Attribution can revise recent history. Refresh the latest 14 complete days.
        start = max(date(2025, 10, 1), yesterday - timedelta(days=13))
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
        return {"status": "ok" if scopes else "no_mx_profiles", "credentials_present": True, "scopes": scopes, **meta}
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
            for scope in scopes:
                _ensure_account(scope)
                for grain, writer in (("campaign", _write_campaign_rows), ("product", _write_product_rows)):
                    report_id = client.create_report(scope, start, end, grain=grain)
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

        if end < date.today() - timedelta(days=1):
            db.set_cursor(SOURCE, JOB, end.isoformat(), "through_date")
        else:
            # Stay at the completed historical boundary; subsequent runs refresh recent attribution.
            db.set_cursor(SOURCE, JOB, end.isoformat(), "through_date")
        return {
            "status": "success",
            "start": start.isoformat(),
            "end": end.isoformat(),
            "accounts": len(scopes),
            "records_read": total_read,
            "records_written": total_written,
        }
    finally:
        client.close()
