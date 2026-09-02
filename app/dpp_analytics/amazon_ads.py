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
ATTRIBUTION_WINDOW = "7d_seller_click"
REPORT_TRANSPORT = "reporting_v3"
MAX_BACKFILL_DAYS = 90
REQUIRED_GRAINS = ("campaign", "product", "target", "search_term")


def _num(row: dict[str, Any], *names: str) -> float:
    for name in names:
        value = row.get(name)
        if value not in (None, ""):
            try: return float(value)
            except (TypeError, ValueError): pass
    return 0.0


def _int(row: dict[str, Any], *names: str) -> int: return int(round(_num(row, *names)))
def _json(value: Any) -> str: return json.dumps(value, default=str, separators=(",", ":"))
def _target_key(row: dict[str, Any]) -> str: return str(row.get("keywordId") or row.get("targeting") or row.get("keyword") or "")


class AmazonAdsClient:
    """Read-only Amazon Ads client. Reporting facts are warehouse-neutral so the
    transport can move to unified reporting without changing product semantics."""
    def __init__(self) -> None:
        self.base=settings.ads_api_endpoint; self.client=httpx.Client(timeout=45.0,follow_redirects=True); self._token=None
    def close(self)->None: self.client.close()
    def access_token(self)->str:
        if self._token:return self._token
        r=self.client.post(LWA_TOKEN_URL,data={"grant_type":"refresh_token","refresh_token":settings.ads_refresh_token,"client_id":settings.ads_client_id,"client_secret":settings.ads_client_secret});r.raise_for_status()
        token=r.json().get("access_token")
        if not token: raise RuntimeError("Amazon Ads LWA response did not contain access_token")
        self._token=str(token);return self._token
    def headers(self,scope=None,*,content_type="application/json",accept="application/json"):
        h={"Authorization":f"Bearer {self.access_token()}","Amazon-Advertising-API-ClientId":settings.ads_client_id,"Content-Type":content_type,"Accept":accept}
        if scope:h["Amazon-Advertising-API-Scope"]=str(scope)
        return h
    def discover_advertiser_accounts(self):
        r=self.client.post(f"{self.base}/adsApi/v1/query/advertiserAccounts",headers=self.headers(),json={});r.raise_for_status();return r.json()
    def discover_legacy_profiles(self):
        r=self.client.get(f"{self.base}/v2/profiles",headers=self.headers());r.raise_for_status();b=r.json();return [x for x in b if isinstance(x,dict)] if isinstance(b,list) else []
    def create_report(self,scope,start,end,*,grain):
        common=["date","campaignId","campaignName","impressions","clicks","cost"]
        conv=["purchases7d","sales7d","unitsSoldClicks7d"]
        configs={
          "campaign": {"groupBy":["campaign"],"columns":common[:3]+["campaignStatus"]+common[3:]+conv,"reportTypeId":"spCampaigns"},
          "product": {"groupBy":["advertiser"],"columns":common[:3]+["adGroupId","advertisedSku","advertisedAsin"]+common[3:]+conv,"reportTypeId":"spAdvertisedProduct"},
          "target": {"groupBy":["targeting"],"columns":common[:3]+["adGroupId","keywordId","keyword","keywordType","targeting","matchType"]+common[3:]+conv,"reportTypeId":"spTargeting"},
          "search_term": {"groupBy":["searchTerm"],"columns":common[:3]+["adGroupId","keywordId","keyword","keywordType","targeting","searchTerm","matchType"]+common[3:]+conv,"reportTypeId":"spSearchTerm"},
        }
        if grain not in configs: raise ValueError(f"unsupported Ads report grain: {grain}")
        cfg={"adProduct":AD_PRODUCT,**configs[grain],"timeUnit":"DAILY","format":"GZIP_JSON"}
        stamp=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        payload={"name":f"dpp-{grain}-{start}-{end}-{stamp}","startDate":start.isoformat(),"endDate":end.isoformat(),"configuration":cfg}
        deadline=time.monotonic()+settings.ads_report_poll_timeout_seconds
        while True:
            r=self.client.post(f"{self.base}/reporting/reports",headers=self.headers(scope,content_type="application/vnd.createasyncreportrequest.v3+json",accept="application/vnd.createasyncreportresponse.v3+json"),json=payload)
            try:b=r.json()
            except ValueError:b={}
            rid=b.get("reportId") or b.get("report_id")
            if r.status_code==425:
                # Reporting v3 returns 425 while an identical request is already
                # processing. Some responses expose the memorized report ID; older
                # variants do not, so retry the same request until Amazon can return it.
                if rid:return str(rid)
                if time.monotonic()>=deadline:raise TimeoutError(f"Amazon Ads duplicate {grain} report did not become available within timeout")
                time.sleep(settings.ads_report_poll_seconds)
                continue
            if r.status_code>=400:
                detail=r.text.strip()
                if len(detail)>2000:detail=detail[:2000]+"..."
                raise RuntimeError(f"Amazon Ads createReport grain={grain} failed: HTTP {r.status_code}: {detail or '<empty response>'}")
            r.raise_for_status()
            if not rid: raise RuntimeError(f"Amazon Ads createReport returned no reportId: {b}")
            return str(rid)
    def wait_for_report(self,scope,report_id,*,on_status=None):
        deadline=time.monotonic()+settings.ads_report_poll_timeout_seconds
        while time.monotonic()<deadline:
            r=self.client.get(f"{self.base}/reporting/reports/{report_id}",headers=self.headers(scope,accept="application/vnd.getasyncreportresponse.v3+json"));r.raise_for_status();b=r.json();status=str(b.get("status") or "").upper()
            if on_status:on_status(status,b)
            if status in {"COMPLETED","SUCCESS"}:return b
            if status in {"FAILURE","FAILED","CANCELLED"}:raise RuntimeError(f"Amazon Ads report {report_id} ended with status={status}: {b}")
            time.sleep(settings.ads_report_poll_seconds)
        raise TimeoutError(f"Amazon Ads report {report_id} did not complete within timeout")
    def download_report(self,location):
        r=self.client.get(location);r.raise_for_status();raw=r.content
        if raw[:2]==b"\x1f\x8b":raw=gzip.GzipFile(fileobj=io.BytesIO(raw)).read()
        text=raw.decode("utf-8-sig").strip()
        if not text:return []
        try:
            p=json.loads(text)
            if isinstance(p,list):return [x for x in p if isinstance(x,dict)]
            if isinstance(p,dict):
                for k in ("rows","data","records"):
                    if isinstance(p.get(k),list):return [x for x in p[k] if isinstance(x,dict)]
                return [p]
        except json.JSONDecodeError:pass
        return [json.loads(x) for x in text.splitlines() if x.strip()]


def _walk_records(value):
    found=[]
    if isinstance(value,list):
        for item in value:found.extend(_walk_records(item))
    elif isinstance(value,dict):
        if any(k in value for k in ("advertiserAccountId","profileId","accountId")):found.append(value)
        for child in value.values():
            if isinstance(child,(dict,list)):found.extend(_walk_records(child))
    unique=[];seen=set()
    for row in found:
        marker=_json(row)
        if marker not in seen:seen.add(marker);unique.append(row)
    return unique


def _profile_ids_from_account(row):
    ids=[];direct=row.get("profileId") or row.get("profile_id")
    if direct:ids.append(str(direct))
    for key in ("alternateIds","alternateIdentifiers","countryAccounts","marketplaceAccounts","accounts"):
        for item in row.get(key) or []:
            if not isinstance(item,dict):continue
            profile=item.get("profileId") or item.get("profile_id");country=str(item.get("countryCode") or item.get("country") or "").upper();marketplace=str(item.get("marketplaceId") or "")
            if profile and (not country or country=="MX" or marketplace==settings.marketplace_id):ids.append(str(profile))
    return list(dict.fromkeys(ids))


def _upsert_account(profile,row):
    country=str(row.get("countryCode") or row.get("country") or "MX")[:2].upper() or "MX";currency=str(row.get("currencyCode") or row.get("currency") or "MXN")[:3].upper() or "MXN";info=row.get("accountInfo") if isinstance(row.get("accountInfo"),dict) else {}
    with db.connect() as conn,conn.cursor() as cur:
        cur.execute("""INSERT INTO ads.account(account_id,marketplace_id,country_code,currency,timezone,account_name,account_type,status,last_discovered_at,metadata) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,now(),%s::jsonb) ON CONFLICT(account_id) DO UPDATE SET marketplace_id=COALESCE(EXCLUDED.marketplace_id,ads.account.marketplace_id),country_code=COALESCE(EXCLUDED.country_code,ads.account.country_code),currency=COALESCE(EXCLUDED.currency,ads.account.currency),timezone=COALESCE(EXCLUDED.timezone,ads.account.timezone),account_name=COALESCE(EXCLUDED.account_name,ads.account.account_name),account_type=COALESCE(EXCLUDED.account_type,ads.account.account_type),status=COALESCE(EXCLUDED.status,ads.account.status),last_discovered_at=now(),metadata=EXCLUDED.metadata""",(profile,settings.marketplace_id if country=="MX" else None,country,currency,row.get("timezone") or row.get("timeZone"),row.get("name") or row.get("accountName") or row.get("advertiserName") or info.get("name"),row.get("accountType") or row.get("type") or info.get("type"),row.get("status") or row.get("state"),_json(row)));conn.commit()


def _ensure_required_grains(scope,start):
    with db.connect() as conn,conn.cursor() as cur:
        for grain in REQUIRED_GRAINS:
            cur.execute("""INSERT INTO ads.required_report_grain(account_id,report_grain,ad_product,required,effective_from) VALUES(%s,%s,%s,true,%s) ON CONFLICT(account_id,report_grain,ad_product,effective_from) DO UPDATE SET required=true""",(scope,grain,AD_PRODUCT,start))
        conn.commit()


def _record_report_run(scope,report_id,grain,start,end,row_count,status_payload):
    generated=status_payload.get("generatedAt") or status_payload.get("generated_at") or status_payload.get("createdAt") or status_payload.get("created_at")
    metadata={"vendor_status":status_payload.get("status"),"report_type":status_payload.get("configuration",{}).get("reportTypeId") if isinstance(status_payload.get("configuration"),dict) else None}
    with db.connect() as conn,conn.cursor() as cur:
        cur.execute("""INSERT INTO ads.report_run(account_id,report_id,transport,report_grain,ad_product,start_date,end_date,requested_at,source_generated_at,ingested_at,status,row_count,metadata) VALUES(%s,%s,%s,%s,%s,%s,%s,NULL,%s,now(),'INGESTED',%s,%s::jsonb) ON CONFLICT(account_id,report_id) DO UPDATE SET transport=EXCLUDED.transport,report_grain=EXCLUDED.report_grain,ad_product=EXCLUDED.ad_product,start_date=EXCLUDED.start_date,end_date=EXCLUDED.end_date,source_generated_at=COALESCE(EXCLUDED.source_generated_at,ads.report_run.source_generated_at),ingested_at=now(),status='INGESTED',row_count=EXCLUDED.row_count,metadata=EXCLUDED.metadata""",(scope,report_id,REPORT_TRANSPORT,grain,AD_PRODUCT,start,end,generated,row_count,_json(metadata)))
        conn.commit()


def discover_scopes(client):
    if settings.ads_account_ids:
        for s in settings.ads_account_ids:_upsert_account(s,{"countryCode":"MX","currencyCode":"MXN","source":"configured"})
        return list(settings.ads_account_ids),{"source":"configured","profiles":len(settings.ads_account_ids)}
    payload=client.discover_advertiser_accounts();records=_walk_records(payload);scopes=[]
    for row in records:
        for profile in _profile_ids_from_account(row):scopes.append(profile);_upsert_account(profile,row)
    legacy=0
    if not scopes:
        profiles=client.discover_legacy_profiles();legacy=len(profiles)
        for row in profiles:
            profile=row.get("profileId");country=str(row.get("countryCode") or "").upper()
            if profile and (not country or country=="MX"):scopes.append(str(profile));_upsert_account(str(profile),row)
    scopes=list(dict.fromkeys(scopes));return scopes,{"source":"advertiser_accounts_v1" if scopes and not legacy else "profiles_v2_fallback","advertiser_records":len(records),"legacy_profiles_seen":legacy,"profiles":len(scopes)}


def _ensure_account(scope):_upsert_account(scope,{"countryCode":"MX","currencyCode":"MXN","source":"reporting_scope"})


def _write_campaign_rows(scope,rows,report_id):
    written=0
    with db.connect() as conn,conn.cursor() as cur:
        for row in rows:
            cid=str(row.get("campaignId") or "");day=row.get("date")
            if not cid or not day:continue
            cur.execute("""INSERT INTO ads.campaign(account_id,campaign_id,ad_product,campaign_name,state,last_seen_at,metadata) VALUES(%s,%s,%s,%s,%s,now(),%s::jsonb) ON CONFLICT(account_id,campaign_id) DO UPDATE SET campaign_name=COALESCE(EXCLUDED.campaign_name,ads.campaign.campaign_name),state=COALESCE(EXCLUDED.state,ads.campaign.state),last_seen_at=now(),metadata=EXCLUDED.metadata""",(scope,cid,AD_PRODUCT,row.get("campaignName"),row.get("campaignStatus"),_json(row)))
            cur.execute("""INSERT INTO ads.daily_campaign(account_id,campaign_id,business_date,ad_product,impressions,clicks,spend,attributed_sales,purchases,units,currency,attribution_method,attribution_window,source_report_id,source_generated_at,ingested_at) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'MXN','click',%s,%s,now(),now()) ON CONFLICT(account_id,campaign_id,business_date) DO UPDATE SET impressions=EXCLUDED.impressions,clicks=EXCLUDED.clicks,spend=EXCLUDED.spend,attributed_sales=EXCLUDED.attributed_sales,purchases=EXCLUDED.purchases,units=EXCLUDED.units,attribution_method=EXCLUDED.attribution_method,attribution_window=EXCLUDED.attribution_window,source_report_id=EXCLUDED.source_report_id,source_generated_at=EXCLUDED.source_generated_at,ingested_at=now()""",(scope,cid,day,AD_PRODUCT,_int(row,"impressions"),_int(row,"clicks"),_num(row,"cost","spend"),_num(row,"sales7d","sales"),_int(row,"purchases7d","purchases"),_int(row,"unitsSoldClicks7d","unitsSold7d","units"),ATTRIBUTION_WINDOW,report_id));written+=1
        conn.commit()
    return written


def _write_product_rows(scope,rows,report_id):
    written=0
    with db.connect() as conn,conn.cursor() as cur:
        for row in rows:
            cid=str(row.get("campaignId") or "");day=row.get("date")
            if not cid or not day:continue
            cur.execute("""INSERT INTO ads.campaign(account_id,campaign_id,ad_product,campaign_name,last_seen_at,metadata) VALUES(%s,%s,%s,%s,now(),%s::jsonb) ON CONFLICT(account_id,campaign_id) DO UPDATE SET campaign_name=COALESCE(EXCLUDED.campaign_name,ads.campaign.campaign_name),last_seen_at=now()""",(scope,cid,AD_PRODUCT,row.get("campaignName"),_json({"source":"advertised_product_report"})))
            cur.execute("""INSERT INTO ads.daily_advertised_product(account_id,business_date,ad_product,campaign_id,ad_group_id,advertised_sku,advertised_asin,impressions,clicks,spend,attributed_sales,purchases,units,currency,attribution_method,attribution_window,source_report_id,source_generated_at,ingested_at) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'MXN','click',%s,%s,now(),now()) ON CONFLICT(account_id,business_date,ad_product,campaign_id,ad_group_id,advertised_sku,advertised_asin) DO UPDATE SET impressions=EXCLUDED.impressions,clicks=EXCLUDED.clicks,spend=EXCLUDED.spend,attributed_sales=EXCLUDED.attributed_sales,purchases=EXCLUDED.purchases,units=EXCLUDED.units,attribution_method=EXCLUDED.attribution_method,attribution_window=EXCLUDED.attribution_window,source_report_id=EXCLUDED.source_report_id,source_generated_at=EXCLUDED.source_generated_at,ingested_at=now()""",(scope,day,AD_PRODUCT,cid,str(row.get("adGroupId") or ""),str(row.get("advertisedSku") or ""),str(row.get("advertisedAsin") or ""),_int(row,"impressions"),_int(row,"clicks"),_num(row,"cost","spend"),_num(row,"sales7d","sales"),_int(row,"purchases7d","purchases"),_int(row,"unitsSoldClicks7d","unitsSold7d","units"),ATTRIBUTION_WINDOW,report_id));written+=1
        conn.commit()
    return written


def _write_target_rows(scope,rows,report_id):
    written=0
    with db.connect() as conn,conn.cursor() as cur:
        for row in rows:
            day=row.get("date");cid=str(row.get("campaignId") or "");tid=_target_key(row)
            if not day or not cid or not tid:continue
            cur.execute("""INSERT INTO ads.daily_target(account_id,business_date,ad_product,campaign_id,ad_group_id,target_id,target_type,target_expression,match_type,impressions,clicks,spend,attributed_sales,purchases,units,currency,attribution_method,attribution_window,source_report_id,source_generated_at,ingested_at) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'MXN','click',%s,%s,now(),now()) ON CONFLICT(account_id,target_id,business_date) DO UPDATE SET ad_product=EXCLUDED.ad_product,campaign_id=EXCLUDED.campaign_id,ad_group_id=EXCLUDED.ad_group_id,target_type=EXCLUDED.target_type,target_expression=EXCLUDED.target_expression,match_type=EXCLUDED.match_type,impressions=EXCLUDED.impressions,clicks=EXCLUDED.clicks,spend=EXCLUDED.spend,attributed_sales=EXCLUDED.attributed_sales,purchases=EXCLUDED.purchases,units=EXCLUDED.units,source_report_id=EXCLUDED.source_report_id,source_generated_at=EXCLUDED.source_generated_at,ingested_at=now()""",(scope,day,AD_PRODUCT,cid,str(row.get("adGroupId") or ""),tid,row.get("keywordType") or row.get("targetingType"),row.get("targeting") or row.get("keyword"),row.get("matchType"),_int(row,"impressions"),_int(row,"clicks"),_num(row,"cost","spend"),_num(row,"sales7d","sales"),_int(row,"purchases7d","purchases"),_int(row,"unitsSoldClicks7d","units"),ATTRIBUTION_WINDOW,report_id));written+=1
        conn.commit()
    return written


def _write_search_term_rows(scope,rows,report_id):
    written=0
    with db.connect() as conn,conn.cursor() as cur:
        for row in rows:
            day=row.get("date");cid=str(row.get("campaignId") or "");term=str(row.get("searchTerm") or "").strip()
            if not day or not cid or not term:continue
            cur.execute("""INSERT INTO ads.daily_search_term(account_id,business_date,ad_product,campaign_id,ad_group_id,target_id,search_term,match_type,impressions,clicks,spend,attributed_sales,purchases,units,currency,attribution_method,attribution_window,source_report_id,source_generated_at,ingested_at) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'MXN','click',%s,%s,now(),now()) ON CONFLICT(account_id,business_date,campaign_id,ad_group_id,target_id,search_term) DO UPDATE SET ad_product=EXCLUDED.ad_product,match_type=EXCLUDED.match_type,impressions=EXCLUDED.impressions,clicks=EXCLUDED.clicks,spend=EXCLUDED.spend,attributed_sales=EXCLUDED.attributed_sales,purchases=EXCLUDED.purchases,units=EXCLUDED.units,source_report_id=EXCLUDED.source_report_id,source_generated_at=EXCLUDED.source_generated_at,ingested_at=now()""",(scope,day,AD_PRODUCT,cid,str(row.get("adGroupId") or ""),_target_key(row),term,row.get("matchType"),_int(row,"impressions"),_int(row,"clicks"),_num(row,"cost","spend"),_num(row,"sales7d","sales"),_int(row,"purchases7d","purchases"),_int(row,"unitsSoldClicks7d","units"),ATTRIBUTION_WINDOW,report_id));written+=1
        conn.commit()
    return written


def _refresh_daily_account(scope,start,end):
    with db.connect() as conn,conn.cursor() as cur:
        cur.execute("""INSERT INTO ads.daily_account(account_id,business_date,ad_product,impressions,clicks,spend,attributed_sales,purchases,units,currency,attribution_method,attribution_window,source_generated_at,ingested_at) SELECT account_id,business_date,%s,sum(impressions),sum(clicks),sum(spend),sum(attributed_sales),sum(purchases),sum(units),'MXN','click',%s,max(source_generated_at),now() FROM ads.daily_campaign WHERE account_id=%s AND business_date BETWEEN %s AND %s GROUP BY account_id,business_date ON CONFLICT(account_id,business_date,ad_product) DO UPDATE SET impressions=EXCLUDED.impressions,clicks=EXCLUDED.clicks,spend=EXCLUDED.spend,attributed_sales=EXCLUDED.attributed_sales,purchases=EXCLUDED.purchases,units=EXCLUDED.units,attribution_method=EXCLUDED.attribution_method,attribution_window=EXCLUDED.attribution_window,source_generated_at=EXCLUDED.source_generated_at,ingested_at=now()""",(AD_PRODUCT,ATTRIBUTION_WINDOW,scope,start,end));conn.commit()


def _next_window():
    yesterday=date.today()-timedelta(days=1);earliest=max(date(2025,10,1),date.today()-timedelta(days=min(settings.ads_backfill_days,MAX_BACKFILL_DAYS)));cursor=db.get_cursor(SOURCE,JOB,"through_date")
    start=max(earliest,date.fromisoformat(cursor)+timedelta(days=1)) if cursor else earliest
    if start>yesterday:start=max(earliest,yesterday-timedelta(days=13))
    return start,min(yesterday,start+timedelta(days=30))


def _publish_state(state, detail_code, **metadata):
    db.set_integration_state("amazon_ads", state, detail_code, metadata)


def _report_progress_callback(scope, grain, report_id, start, end, report_number, report_total):
    metadata={
        "account_id":str(scope),
        "grain":grain,
        "report_number":report_number,
        "report_total":report_total,
        "report_id":report_id,
        "vendor_status":"REQUESTED",
        "start_date":start.isoformat(),
        "end_date":end.isoformat(),
        "report_started_at":datetime.now(timezone.utc).isoformat(),
        "last_polled_at":None,
    }
    last_status=None
    last_published_at=0.0

    def publish(vendor_status, _payload):
        nonlocal last_status,last_published_at
        now=time.monotonic()
        if vendor_status==last_status and now-last_published_at<30:return
        last_status=vendor_status;last_published_at=now
        metadata["vendor_status"]=vendor_status or "UNKNOWN"
        metadata["last_polled_at"]=datetime.now(timezone.utc).isoformat()
        _publish_state("BACKFILL_RUNNING","REPORT_VENDOR_PROCESSING",**metadata)

    return publish,metadata


def _backfill_complete():
    cursor = db.get_cursor(SOURCE, JOB, "through_date")
    if not cursor:
        return False
    try:
        return date.fromisoformat(cursor) >= date.today() - timedelta(days=1)
    except ValueError:
        return False


def probe_ads():
    if not settings.ads_enabled:
        _publish_state("NOT_CONNECTED", "ADS_DISABLED")
        return {"status":"disabled","credentials_present":settings.ads_credentials_present}
    if not settings.ads_credentials_present:
        _publish_state("AUTHORIZATION_PENDING", "CREDENTIALS_INCOMPLETE")
        return {"status":"missing_credentials","credentials_present":False}
    client=AmazonAdsClient()
    try:
        scopes,meta=discover_scopes(client)
        if not scopes:
            _publish_state("AUTHORIZATION_PENDING", "NO_MX_ADVERTISER_PROFILE")
        elif _backfill_complete():
            _publish_state("READY", "REPORTING_CURRENT", accounts=len(scopes))
        else:
            _publish_state("BACKFILL_RUNNING", "INITIAL_HISTORY_PENDING", accounts=len(scopes))
        return {"status":"ok" if scopes else "no_mx_profiles","credentials_present":True,"scopes":scopes,**meta}
    except Exception:
        _publish_state("FAILED", "AUTHORIZATION_PROBE_FAILED")
        raise
    finally:client.close()


def ingest_ads():
    if not settings.ads_enabled:
        _publish_state("NOT_CONNECTED", "ADS_DISABLED")
        return {"status":"disabled"}
    if not settings.ads_credentials_present:
        _publish_state("AUTHORIZATION_PENDING", "CREDENTIALS_INCOMPLETE")
        return {"status":"missing_credentials"}
    start,end=_next_window();client=AmazonAdsClient();failure_context={"start_date":start.isoformat(),"end_date":end.isoformat()}
    try:
        _publish_state("BACKFILL_RUNNING", "REPORT_WINDOW_RUNNING", start=start.isoformat(), end=end.isoformat())
        scopes,discovery=discover_scopes(client)
        if not scopes:
            _publish_state("AUTHORIZATION_PENDING", "NO_MX_ADVERTISER_PROFILE")
            return {"status":"no_mx_profiles","window":[start.isoformat(),end.isoformat()],**discovery}
        with db.ingestion_run(SOURCE,JOB,{"start":start.isoformat(),"end":end.isoformat(),**discovery}) as run:
            total_read=total_written=0;report_ids=[];grains={"campaign":_write_campaign_rows,"product":_write_product_rows,"target":_write_target_rows,"search_term":_write_search_term_rows}
            for scope in scopes:
                _ensure_account(scope);_ensure_required_grains(scope,start)
                for report_number,(grain,writer) in enumerate(grains.items(),start=1):
                    rid=client.create_report(scope,start,end,grain=grain);report_ids.append(rid);progress,failure_context=_report_progress_callback(scope,grain,rid,start,end,report_number,len(grains));progress("REQUESTED",{});status=client.wait_for_report(scope,rid,on_status=progress);location=status.get("url") or status.get("location")
                    if not location:raise RuntimeError(f"Amazon Ads report {rid} completed without download URL: {status}")
                    rows=client.download_report(str(location));total_read+=len(rows)
                    try:written=writer(scope,rows,rid)
                    except Exception as exc:raise RuntimeError(f"Amazon Ads write grain={grain} report_id={rid} failed: {exc}") from exc
                    total_written+=written
                    _record_report_run(scope,rid,grain,start,end,len(rows),status)
                _refresh_daily_account(scope,start,end)
            run["records_read"]=total_read;run["records_written"]=total_written
        db.set_cursor(SOURCE,JOB,end.isoformat(),"through_date")
        if end >= date.today()-timedelta(days=1):
            _publish_state("READY", "REPORTING_CURRENT", accounts=len(scopes), through_date=end.isoformat())
        else:
            _publish_state("BACKFILL_RUNNING", "INITIAL_HISTORY_PENDING", accounts=len(scopes), through_date=end.isoformat())
        return {"status":"success","start":start.isoformat(),"end":end.isoformat(),"accounts":len(scopes),"records_read":total_read,"records_written":total_written,"report_ids":report_ids,"grains":list(grains),"transport":REPORT_TRANSPORT,"attribution_window":ATTRIBUTION_WINDOW}
    except Exception:
        _publish_state("FAILED", "REPORT_INGESTION_FAILED", **failure_context)
        raise
    finally:client.close()
