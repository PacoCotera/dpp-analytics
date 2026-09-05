from __future__ import annotations

import gzip
from hashlib import sha256
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
TRAFFIC_QUALITY_JOB = "sponsored_products_gross_invalid_v1"
AD_PRODUCT = "SPONSORED_PRODUCTS"
ATTRIBUTION_WINDOW = "7d_seller_click"
REPORT_TRANSPORT = "reporting_v3"
MAX_BACKFILL_DAYS = 90
TRAFFIC_QUALITY_BACKFILL_DAYS = 365
TRAFFIC_QUALITY_THROUGH_CURSOR = "through_date"
REQUIRED_GRAINS = (
    "campaign",
    "product",
    "target",
    "search_term",
    "ad_group",
    "placement",
    "purchased_product",
)
TOKEN_REFRESH_SAFETY_SECONDS = 60
DEFAULT_TOKEN_LIFETIME_SECONDS = 3600
REPORT_CONTRACT_VERSION = 2
THROUGH_CURSOR = "through_date_v2"
INITIAL_HISTORY_CURSOR = "initial_history_v2_complete"


def _num(row: dict[str, Any], *names: str) -> float:
    for name in names:
        value = row.get(name)
        if value not in (None, ""):
            try: return float(value)
            except (TypeError, ValueError): pass
    return 0.0


def _int(row: dict[str, Any], *names: str) -> int: return int(round(_num(row, *names)))
def _optional_num(row: dict[str, Any], name: str) -> float | None:
    value=row.get(name)
    if value in (None,""):return None
    try:return float(value)
    except (TypeError,ValueError):return None
def _optional_int(row: dict[str, Any], name: str) -> int | None:
    value=_optional_num(row,name);return int(round(value)) if value is not None else None
def _json(value: Any) -> str: return json.dumps(value, default=str, separators=(",", ":"))
def _target_key(row: dict[str, Any]) -> str: return str(row.get("keywordId") or row.get("targeting") or row.get("keyword") or "")


class AmazonAdsClient:
    """Read-only Amazon Ads client. Reporting facts are warehouse-neutral so the
    transport can move to unified reporting without changing product semantics."""
    def __init__(self) -> None:
        self.base=settings.ads_api_endpoint; self.client=httpx.Client(timeout=45.0,follow_redirects=True); self._token=None; self._token_expires_at=0.0
    def close(self)->None: self.client.close()
    def _invalidate_access_token(self)->None:
        self._token=None;self._token_expires_at=0.0
    def access_token(self)->str:
        now=time.monotonic()
        if self._token and now < getattr(self,"_token_expires_at",0.0):return self._token
        r=self.client.post(LWA_TOKEN_URL,data={"grant_type":"refresh_token","refresh_token":settings.ads_refresh_token,"client_id":settings.ads_client_id,"client_secret":settings.ads_client_secret});r.raise_for_status()
        payload=r.json();token=payload.get("access_token")
        if not token: raise RuntimeError("Amazon Ads LWA response did not contain access_token")
        try:lifetime=max(1,int(payload.get("expires_in") or DEFAULT_TOKEN_LIFETIME_SECONDS))
        except (TypeError,ValueError):lifetime=DEFAULT_TOKEN_LIFETIME_SECONDS
        self._token=str(token);self._token_expires_at=now+max(1,lifetime-TOKEN_REFRESH_SAFETY_SECONDS);return self._token
    def headers(self,scope=None,*,content_type="application/json",accept="application/json"):
        h={"Authorization":f"Bearer {self.access_token()}","Amazon-Advertising-API-ClientId":settings.ads_client_id,"Accept":accept}
        if content_type:h["Content-Type"]=content_type
        if scope:h["Amazon-Advertising-API-Scope"]=str(scope)
        return h
    def authenticated_request(self,method,url,scope=None,*,content_type="application/json",accept="application/json",**kwargs):
        request=getattr(self.client,str(method).lower())
        response=request(url,headers=self.headers(scope,content_type=content_type,accept=accept),**kwargs)
        if response.status_code!=401:return response
        # A Reporting v3 job may outlive the one-hour LWA token. Renew the
        # access token and retry the same authenticated operation once. A poll
        # remains a GET for the existing report ID, so this cannot create a
        # duplicate report while recovering an in-flight job.
        self._invalidate_access_token()
        return request(url,headers=self.headers(scope,content_type=content_type,accept=accept),**kwargs)
    def discover_advertiser_accounts(self):
        r=self.authenticated_request("post",f"{self.base}/adsApi/v1/query/advertiserAccounts",json={});r.raise_for_status();return r.json()
    def discover_legacy_profiles(self):
        r=self.authenticated_request("get",f"{self.base}/v2/profiles");r.raise_for_status();b=r.json();return [x for x in b if isinstance(x,dict)] if isinstance(b,list) else []
    def create_report(self,scope,start,end,*,grain):
        common=["date","campaignId","campaignName","impressions","clicks","cost"]
        conv=["purchases7d","sales7d","unitsSoldClicks7d"]
        configs={
          "campaign": {"groupBy":["campaign"],"columns":common[:3]+["campaignStatus"]+common[3:]+conv+["purchasesSameSku7d","attributedSalesSameSku7d","campaignBiddingStrategy","campaignBudgetAmount","campaignBudgetType","campaignRuleBasedBudgetAmount","campaignApplicableBudgetRuleId","campaignApplicableBudgetRuleName","topOfSearchImpressionShare"],"reportTypeId":"spCampaigns"},
          "product": {"groupBy":["advertiser"],"columns":common[:3]+["adGroupId","adId","advertisedSku","advertisedAsin","portfolioId"]+common[3:]+conv+["purchasesSameSku7d","attributedSalesSameSku7d","salesOtherSku7d","unitsSoldOtherSku7d","campaignBudgetAmount","campaignBudgetType","campaignStatus"],"reportTypeId":"spAdvertisedProduct"},
          "target": {"groupBy":["targeting"],"columns":common[:3]+["adGroupId","keywordId","keyword","keywordType","targeting","matchType","keywordBid","adKeywordStatus","portfolioId"]+common[3:]+conv+["purchasesSameSku7d","attributedSalesSameSku7d","salesOtherSku7d","unitsSoldOtherSku7d","topOfSearchImpressionShare"],"reportTypeId":"spTargeting"},
          "search_term": {"groupBy":["searchTerm"],"columns":common[:3]+["adGroupId","keywordId","keyword","keywordType","targeting","searchTerm","matchType","keywordBid","adKeywordStatus","portfolioId"]+common[3:]+conv+["purchasesSameSku7d","attributedSalesSameSku7d","salesOtherSku7d","unitsSoldOtherSku7d"],"reportTypeId":"spSearchTerm"},
          "ad_group": {"groupBy":["campaign","adGroup"],"columns":common[:3]+["adGroupId","adGroupName","adStatus"]+common[3:]+["purchases7d","purchasesSameSku7d","sales7d","attributedSalesSameSku7d"],"reportTypeId":"spCampaigns"},
          "placement": {"groupBy":["campaignPlacement"],"columns":common[:3]+["placementClassification"]+common[3:]+["purchases7d","purchasesSameSku7d","sales7d","attributedSalesSameSku7d","campaignBiddingStrategy","campaignBudgetAmount","campaignBudgetType","campaignRuleBasedBudgetAmount","campaignApplicableBudgetRuleId","campaignApplicableBudgetRuleName","topOfSearchImpressionShare"],"reportTypeId":"spCampaigns"},
          "purchased_product": {"groupBy":["asin"],"columns":common[:3]+["adGroupId","keywordId","keyword","keywordType","matchType","advertisedSku","advertisedAsin","purchasedAsin","purchases7d","sales7d","purchasesOtherSku7d","salesOtherSku7d","unitsSoldOtherSku7d"],"reportTypeId":"spPurchasedProduct"},
          "gross_invalid": {"groupBy":["campaign"],"columns":["campaignName","campaignStatus","impressions","clicks","grossImpressions","invalidImpressions","invalidImpressionRate","grossClickThroughs","invalidClickThroughs","invalidClickThroughRate","startDate","endDate"],"reportTypeId":"spGrossAndInvalids"},
        }
        if grain not in configs: raise ValueError(f"unsupported Ads report grain: {grain}")
        cfg={"adProduct":AD_PRODUCT,**configs[grain],"timeUnit":"SUMMARY" if grain=="gross_invalid" else "DAILY","format":"GZIP_JSON"}
        stamp=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        payload={"name":f"dpp-{grain}-{start}-{end}-{stamp}","startDate":start.isoformat(),"endDate":end.isoformat(),"configuration":cfg}
        deadline=time.monotonic()+settings.ads_report_poll_timeout_seconds
        while True:
            r=self.authenticated_request("post",f"{self.base}/reporting/reports",scope,content_type="application/vnd.createasyncreportrequest.v3+json",accept="application/vnd.createasyncreportresponse.v3+json",json=payload)
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
            r=self.authenticated_request("get",f"{self.base}/reporting/reports/{report_id}",scope,accept="application/vnd.getasyncreportresponse.v3+json");r.raise_for_status();b=r.json();status=str(b.get("status") or "").upper()
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
    metadata={"vendor_status":status_payload.get("status"),"report_type":status_payload.get("configuration",{}).get("reportTypeId") if isinstance(status_payload.get("configuration"),dict) else None,"report_contract_version":REPORT_CONTRACT_VERSION}
    with db.connect() as conn,conn.cursor() as cur:
        cur.execute("""INSERT INTO ads.report_run(account_id,report_id,transport,report_grain,ad_product,start_date,end_date,requested_at,source_generated_at,ingested_at,status,row_count,metadata) VALUES(%s,%s,%s,%s,%s,%s,%s,NULL,%s,now(),'INGESTED',%s,%s::jsonb) ON CONFLICT(account_id,report_id) DO UPDATE SET transport=EXCLUDED.transport,report_grain=EXCLUDED.report_grain,ad_product=EXCLUDED.ad_product,start_date=EXCLUDED.start_date,end_date=EXCLUDED.end_date,source_generated_at=COALESCE(EXCLUDED.source_generated_at,ads.report_run.source_generated_at),ingested_at=now(),status='INGESTED',row_count=EXCLUDED.row_count,metadata=EXCLUDED.metadata""",(scope,report_id,REPORT_TRANSPORT,grain,AD_PRODUCT,start,end,generated,row_count,_json(metadata)))
        conn.commit()


def _canonical_report_content(rows):
    serialized_rows = sorted(
        json.dumps(row, default=str, separators=(",", ":"), sort_keys=True)
        for row in rows
    )
    content = ("[" + ",".join(serialized_rows) + "]").encode("utf-8")
    return content, gzip.compress(content, compresslevel=9, mtime=0)


def _record_report_content(scope,report_id,grain,start,end,rows,status_payload):
    """Retain immutable, compressed source facts before latest-state upserts."""

    content, compressed = _canonical_report_content(rows)
    digest = sha256(content).hexdigest()
    generated = status_payload.get("generatedAt") or status_payload.get("generated_at") or status_payload.get("createdAt") or status_payload.get("created_at")
    with db.connect() as conn,conn.cursor() as cur:
        cur.execute(
            """INSERT INTO ads.report_content(
                   content_sha256,encoding,row_count,uncompressed_bytes,compressed_bytes,payload
               ) VALUES(%s,'GZIP_CANONICAL_JSON_ROWS_V1',%s,%s,%s,%s)
               ON CONFLICT(content_sha256) DO NOTHING""",
            (digest,len(rows),len(content),len(compressed),compressed),
        )
        cur.execute(
            """INSERT INTO ads.report_content_observation(
                   account_id,report_id,report_grain,ad_product,start_date,end_date,
                   source_generated_at,content_sha256,row_count
               ) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT(account_id,report_id,content_sha256) DO NOTHING""",
            (scope,report_id,grain,AD_PRODUCT,start,end,generated,digest,len(rows)),
        )
        conn.commit()
    return {
        "content_sha256":digest,
        "rows":len(rows),
        "uncompressed_bytes":len(content),
        "compressed_bytes":len(compressed),
    }


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


def _write_extended_report_fields(cur,scope,grain,row):
    day=row.get("date");campaign_id=str(row.get("campaignId") or "")
    if grain=="campaign":
        cur.execute("""UPDATE ads.daily_campaign SET attributed_sales_same_sku=%s,purchases_same_sku=%s,campaign_bidding_strategy=%s,campaign_budget=%s,campaign_budget_type=%s,campaign_rule_based_budget=%s,applicable_budget_rule_id=%s,applicable_budget_rule_name=%s,top_of_search_impression_share=%s WHERE account_id=%s AND campaign_id=%s AND business_date=%s""",(_optional_num(row,"attributedSalesSameSku7d"),_optional_int(row,"purchasesSameSku7d"),row.get("campaignBiddingStrategy"),_optional_num(row,"campaignBudgetAmount"),row.get("campaignBudgetType"),_optional_num(row,"campaignRuleBasedBudgetAmount"),row.get("campaignApplicableBudgetRuleId"),row.get("campaignApplicableBudgetRuleName"),_optional_num(row,"topOfSearchImpressionShare"),scope,campaign_id,day))
        cur.execute("""UPDATE ads.campaign SET budget=%s,budget_type=%s,state=COALESCE(%s,state),campaign_name=COALESCE(%s,campaign_name),last_seen_at=now() WHERE account_id=%s AND campaign_id=%s""",(_optional_num(row,"campaignBudgetAmount"),row.get("campaignBudgetType"),row.get("campaignStatus"),row.get("campaignName"),scope,campaign_id))
    elif grain=="product":
        cur.execute("""UPDATE ads.daily_advertised_product SET ad_id=%s,portfolio_id=%s,attributed_sales_same_sku=%s,purchases_same_sku=%s,attributed_sales_other_sku=%s,units_other_sku=%s,campaign_budget=%s,campaign_budget_type=%s,campaign_status=%s WHERE account_id=%s AND business_date=%s AND ad_product=%s AND campaign_id=%s AND ad_group_id=%s AND advertised_sku=%s AND advertised_asin=%s""",(row.get("adId"),row.get("portfolioId"),_optional_num(row,"attributedSalesSameSku7d"),_optional_int(row,"purchasesSameSku7d"),_optional_num(row,"salesOtherSku7d"),_optional_int(row,"unitsSoldOtherSku7d"),_optional_num(row,"campaignBudgetAmount"),row.get("campaignBudgetType"),row.get("campaignStatus"),scope,day,AD_PRODUCT,campaign_id,str(row.get("adGroupId") or ""),str(row.get("advertisedSku") or ""),str(row.get("advertisedAsin") or "")))
    elif grain=="target":
        cur.execute("""UPDATE ads.daily_target SET keyword_bid=%s,target_status=%s,portfolio_id=%s,attributed_sales_same_sku=%s,purchases_same_sku=%s,attributed_sales_other_sku=%s,units_other_sku=%s,top_of_search_impression_share=%s WHERE account_id=%s AND target_id=%s AND business_date=%s""",(_optional_num(row,"keywordBid"),row.get("adKeywordStatus"),row.get("portfolioId"),_optional_num(row,"attributedSalesSameSku7d"),_optional_int(row,"purchasesSameSku7d"),_optional_num(row,"salesOtherSku7d"),_optional_int(row,"unitsSoldOtherSku7d"),_optional_num(row,"topOfSearchImpressionShare"),scope,_target_key(row),day))
    elif grain=="search_term":
        cur.execute("""UPDATE ads.daily_search_term SET keyword_bid=%s,target_status=%s,portfolio_id=%s,attributed_sales_same_sku=%s,purchases_same_sku=%s,attributed_sales_other_sku=%s,units_other_sku=%s WHERE account_id=%s AND business_date=%s AND campaign_id=%s AND ad_group_id=%s AND target_id=%s AND search_term=%s""",(_optional_num(row,"keywordBid"),row.get("adKeywordStatus"),row.get("portfolioId"),_optional_num(row,"attributedSalesSameSku7d"),_optional_int(row,"purchasesSameSku7d"),_optional_num(row,"salesOtherSku7d"),_optional_int(row,"unitsSoldOtherSku7d"),scope,day,campaign_id,str(row.get("adGroupId") or ""),_target_key(row),str(row.get("searchTerm") or "").strip()))


def _write_campaign_rows(scope,rows,report_id):
    written=0
    with db.connect() as conn,conn.cursor() as cur:
        for row in rows:
            cid=str(row.get("campaignId") or "");day=row.get("date")
            if not cid or not day:continue
            cur.execute("""INSERT INTO ads.campaign(account_id,campaign_id,ad_product,campaign_name,state,last_seen_at,metadata) VALUES(%s,%s,%s,%s,%s,now(),%s::jsonb) ON CONFLICT(account_id,campaign_id) DO UPDATE SET campaign_name=COALESCE(EXCLUDED.campaign_name,ads.campaign.campaign_name),state=COALESCE(EXCLUDED.state,ads.campaign.state),last_seen_at=now(),metadata=EXCLUDED.metadata""",(scope,cid,AD_PRODUCT,row.get("campaignName"),row.get("campaignStatus"),_json(row)))
            cur.execute("""INSERT INTO ads.daily_campaign(account_id,campaign_id,business_date,ad_product,impressions,clicks,spend,attributed_sales,purchases,units,currency,attribution_method,attribution_window,source_report_id,source_generated_at,ingested_at) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'MXN','click',%s,%s,now(),now()) ON CONFLICT(account_id,campaign_id,business_date) DO UPDATE SET impressions=EXCLUDED.impressions,clicks=EXCLUDED.clicks,spend=EXCLUDED.spend,attributed_sales=EXCLUDED.attributed_sales,purchases=EXCLUDED.purchases,units=EXCLUDED.units,attribution_method=EXCLUDED.attribution_method,attribution_window=EXCLUDED.attribution_window,source_report_id=EXCLUDED.source_report_id,source_generated_at=EXCLUDED.source_generated_at,ingested_at=now()""",(scope,cid,day,AD_PRODUCT,_int(row,"impressions"),_int(row,"clicks"),_num(row,"cost","spend"),_num(row,"sales7d","sales"),_int(row,"purchases7d","purchases"),_int(row,"unitsSoldClicks7d","unitsSold7d","units"),ATTRIBUTION_WINDOW,report_id));_write_extended_report_fields(cur,scope,"campaign",row);written+=1
        conn.commit()
    return written


def _write_product_rows(scope,rows,report_id):
    written=0
    with db.connect() as conn,conn.cursor() as cur:
        for row in rows:
            cid=str(row.get("campaignId") or "");day=row.get("date")
            if not cid or not day:continue
            cur.execute("""INSERT INTO ads.campaign(account_id,campaign_id,ad_product,campaign_name,last_seen_at,metadata) VALUES(%s,%s,%s,%s,now(),%s::jsonb) ON CONFLICT(account_id,campaign_id) DO UPDATE SET campaign_name=COALESCE(EXCLUDED.campaign_name,ads.campaign.campaign_name),last_seen_at=now()""",(scope,cid,AD_PRODUCT,row.get("campaignName"),_json({"source":"advertised_product_report"})))
            cur.execute("""INSERT INTO ads.daily_advertised_product(account_id,business_date,ad_product,campaign_id,ad_group_id,advertised_sku,advertised_asin,impressions,clicks,spend,attributed_sales,purchases,units,currency,attribution_method,attribution_window,source_report_id,source_generated_at,ingested_at) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'MXN','click',%s,%s,now(),now()) ON CONFLICT(account_id,business_date,ad_product,campaign_id,ad_group_id,advertised_sku,advertised_asin) DO UPDATE SET impressions=EXCLUDED.impressions,clicks=EXCLUDED.clicks,spend=EXCLUDED.spend,attributed_sales=EXCLUDED.attributed_sales,purchases=EXCLUDED.purchases,units=EXCLUDED.units,attribution_method=EXCLUDED.attribution_method,attribution_window=EXCLUDED.attribution_window,source_report_id=EXCLUDED.source_report_id,source_generated_at=EXCLUDED.source_generated_at,ingested_at=now()""",(scope,day,AD_PRODUCT,cid,str(row.get("adGroupId") or ""),str(row.get("advertisedSku") or ""),str(row.get("advertisedAsin") or ""),_int(row,"impressions"),_int(row,"clicks"),_num(row,"cost","spend"),_num(row,"sales7d","sales"),_int(row,"purchases7d","purchases"),_int(row,"unitsSoldClicks7d","unitsSold7d","units"),ATTRIBUTION_WINDOW,report_id));_write_extended_report_fields(cur,scope,"product",row);written+=1
        conn.commit()
    return written


def _write_target_rows(scope,rows,report_id):
    written=0
    with db.connect() as conn,conn.cursor() as cur:
        for row in rows:
            day=row.get("date");cid=str(row.get("campaignId") or "");tid=_target_key(row)
            if not day or not cid or not tid:continue
            cur.execute("""INSERT INTO ads.daily_target(account_id,business_date,ad_product,campaign_id,ad_group_id,target_id,target_type,target_expression,match_type,impressions,clicks,spend,attributed_sales,purchases,units,currency,attribution_method,attribution_window,source_report_id,source_generated_at,ingested_at) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'MXN','click',%s,%s,now(),now()) ON CONFLICT(account_id,target_id,business_date) DO UPDATE SET ad_product=EXCLUDED.ad_product,campaign_id=EXCLUDED.campaign_id,ad_group_id=EXCLUDED.ad_group_id,target_type=EXCLUDED.target_type,target_expression=EXCLUDED.target_expression,match_type=EXCLUDED.match_type,impressions=EXCLUDED.impressions,clicks=EXCLUDED.clicks,spend=EXCLUDED.spend,attributed_sales=EXCLUDED.attributed_sales,purchases=EXCLUDED.purchases,units=EXCLUDED.units,source_report_id=EXCLUDED.source_report_id,source_generated_at=EXCLUDED.source_generated_at,ingested_at=now()""",(scope,day,AD_PRODUCT,cid,str(row.get("adGroupId") or ""),tid,row.get("keywordType") or row.get("targetingType"),row.get("targeting") or row.get("keyword"),row.get("matchType"),_int(row,"impressions"),_int(row,"clicks"),_num(row,"cost","spend"),_num(row,"sales7d","sales"),_int(row,"purchases7d","purchases"),_int(row,"unitsSoldClicks7d","units"),ATTRIBUTION_WINDOW,report_id));_write_extended_report_fields(cur,scope,"target",row);written+=1
        conn.commit()
    return written


def _write_search_term_rows(scope,rows,report_id):
    written=0
    with db.connect() as conn,conn.cursor() as cur:
        for row in rows:
            day=row.get("date");cid=str(row.get("campaignId") or "");term=str(row.get("searchTerm") or "").strip()
            if not day or not cid or not term:continue
            cur.execute("""INSERT INTO ads.daily_search_term(account_id,business_date,ad_product,campaign_id,ad_group_id,target_id,search_term,match_type,impressions,clicks,spend,attributed_sales,purchases,units,currency,attribution_method,attribution_window,source_report_id,source_generated_at,ingested_at) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'MXN','click',%s,%s,now(),now()) ON CONFLICT(account_id,business_date,campaign_id,ad_group_id,target_id,search_term) DO UPDATE SET ad_product=EXCLUDED.ad_product,match_type=EXCLUDED.match_type,impressions=EXCLUDED.impressions,clicks=EXCLUDED.clicks,spend=EXCLUDED.spend,attributed_sales=EXCLUDED.attributed_sales,purchases=EXCLUDED.purchases,units=EXCLUDED.units,source_report_id=EXCLUDED.source_report_id,source_generated_at=EXCLUDED.source_generated_at,ingested_at=now()""",(scope,day,AD_PRODUCT,cid,str(row.get("adGroupId") or ""),_target_key(row),term,row.get("matchType"),_int(row,"impressions"),_int(row,"clicks"),_num(row,"cost","spend"),_num(row,"sales7d","sales"),_int(row,"purchases7d","purchases"),_int(row,"unitsSoldClicks7d","units"),ATTRIBUTION_WINDOW,report_id));_write_extended_report_fields(cur,scope,"search_term",row);written+=1
        conn.commit()
    return written


def _write_ad_group_rows(scope,rows,report_id):
    written=0
    with db.connect() as conn,conn.cursor() as cur:
        for row in rows:
            day=row.get("date");campaign_id=str(row.get("campaignId") or "");ad_group_id=str(row.get("adGroupId") or "")
            if not day or not campaign_id or not ad_group_id:continue
            cur.execute("""INSERT INTO ads.daily_ad_group(account_id,business_date,campaign_id,ad_group_id,campaign_name,ad_group_name,ad_status,impressions,clicks,spend,attributed_sales,purchases,attributed_sales_same_sku,purchases_same_sku,currency,attribution_method,attribution_window,source_report_id,source_generated_at,ingested_at) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'MXN','click',%s,%s,now(),now()) ON CONFLICT(account_id,business_date,campaign_id,ad_group_id) DO UPDATE SET campaign_name=EXCLUDED.campaign_name,ad_group_name=EXCLUDED.ad_group_name,ad_status=EXCLUDED.ad_status,impressions=EXCLUDED.impressions,clicks=EXCLUDED.clicks,spend=EXCLUDED.spend,attributed_sales=EXCLUDED.attributed_sales,purchases=EXCLUDED.purchases,attributed_sales_same_sku=EXCLUDED.attributed_sales_same_sku,purchases_same_sku=EXCLUDED.purchases_same_sku,source_report_id=EXCLUDED.source_report_id,source_generated_at=EXCLUDED.source_generated_at,ingested_at=now()""",(scope,day,campaign_id,ad_group_id,row.get("campaignName"),row.get("adGroupName"),row.get("adStatus"),_int(row,"impressions"),_int(row,"clicks"),_num(row,"cost"),_num(row,"sales7d"),_int(row,"purchases7d"),_optional_num(row,"attributedSalesSameSku7d"),_optional_int(row,"purchasesSameSku7d"),ATTRIBUTION_WINDOW,report_id));written+=1
        conn.commit()
    return written


def _write_placement_rows(scope,rows,report_id):
    written=0
    with db.connect() as conn,conn.cursor() as cur:
        for row in rows:
            day=row.get("date");campaign_id=str(row.get("campaignId") or "");placement=str(row.get("placementClassification") or "")
            if not day or not campaign_id or not placement:continue
            cur.execute("""INSERT INTO ads.daily_placement(account_id,business_date,campaign_id,placement,campaign_name,impressions,clicks,spend,attributed_sales,purchases,attributed_sales_same_sku,purchases_same_sku,campaign_bidding_strategy,campaign_budget,campaign_budget_type,campaign_rule_based_budget,applicable_budget_rule_id,applicable_budget_rule_name,top_of_search_impression_share,currency,attribution_method,attribution_window,source_report_id,source_generated_at,ingested_at) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'MXN','click',%s,%s,now(),now()) ON CONFLICT(account_id,business_date,campaign_id,placement) DO UPDATE SET campaign_name=EXCLUDED.campaign_name,impressions=EXCLUDED.impressions,clicks=EXCLUDED.clicks,spend=EXCLUDED.spend,attributed_sales=EXCLUDED.attributed_sales,purchases=EXCLUDED.purchases,attributed_sales_same_sku=EXCLUDED.attributed_sales_same_sku,purchases_same_sku=EXCLUDED.purchases_same_sku,campaign_bidding_strategy=EXCLUDED.campaign_bidding_strategy,campaign_budget=EXCLUDED.campaign_budget,campaign_budget_type=EXCLUDED.campaign_budget_type,campaign_rule_based_budget=EXCLUDED.campaign_rule_based_budget,applicable_budget_rule_id=EXCLUDED.applicable_budget_rule_id,applicable_budget_rule_name=EXCLUDED.applicable_budget_rule_name,top_of_search_impression_share=EXCLUDED.top_of_search_impression_share,source_report_id=EXCLUDED.source_report_id,source_generated_at=EXCLUDED.source_generated_at,ingested_at=now()""",(scope,day,campaign_id,placement,row.get("campaignName"),_int(row,"impressions"),_int(row,"clicks"),_num(row,"cost"),_num(row,"sales7d"),_int(row,"purchases7d"),_optional_num(row,"attributedSalesSameSku7d"),_optional_int(row,"purchasesSameSku7d"),row.get("campaignBiddingStrategy"),_optional_num(row,"campaignBudgetAmount"),row.get("campaignBudgetType"),_optional_num(row,"campaignRuleBasedBudgetAmount"),row.get("campaignApplicableBudgetRuleId"),row.get("campaignApplicableBudgetRuleName"),_optional_num(row,"topOfSearchImpressionShare"),ATTRIBUTION_WINDOW,report_id));written+=1
        conn.commit()
    return written


def _write_purchased_product_rows(scope,rows,report_id):
    written=0
    with db.connect() as conn,conn.cursor() as cur:
        for row in rows:
            day=row.get("date");campaign_id=str(row.get("campaignId") or "");purchased_asin=str(row.get("purchasedAsin") or "")
            if not day or not campaign_id or not purchased_asin:continue
            cur.execute("""INSERT INTO ads.daily_purchased_product(account_id,business_date,campaign_id,ad_group_id,target_id,advertised_sku,advertised_asin,purchased_asin,campaign_name,keyword,keyword_type,match_type,purchases,attributed_sales,purchases_other_sku,attributed_sales_other_sku,units_other_sku,currency,attribution_method,attribution_window,source_report_id,source_generated_at,ingested_at) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'MXN','click',%s,%s,now(),now()) ON CONFLICT(account_id,business_date,campaign_id,ad_group_id,target_id,advertised_sku,advertised_asin,purchased_asin) DO UPDATE SET campaign_name=EXCLUDED.campaign_name,keyword=EXCLUDED.keyword,keyword_type=EXCLUDED.keyword_type,match_type=EXCLUDED.match_type,purchases=EXCLUDED.purchases,attributed_sales=EXCLUDED.attributed_sales,purchases_other_sku=EXCLUDED.purchases_other_sku,attributed_sales_other_sku=EXCLUDED.attributed_sales_other_sku,units_other_sku=EXCLUDED.units_other_sku,source_report_id=EXCLUDED.source_report_id,source_generated_at=EXCLUDED.source_generated_at,ingested_at=now()""",(scope,day,campaign_id,str(row.get("adGroupId") or ""),_target_key(row),str(row.get("advertisedSku") or ""),str(row.get("advertisedAsin") or ""),purchased_asin,row.get("campaignName"),row.get("keyword"),row.get("keywordType"),row.get("matchType"),_int(row,"purchases7d"),_num(row,"sales7d"),_optional_int(row,"purchasesOtherSku7d"),_optional_num(row,"salesOtherSku7d"),_optional_int(row,"unitsSoldOtherSku7d"),ATTRIBUTION_WINDOW,report_id));written+=1
        conn.commit()
    return written


def _campaign_name_identity(cur, scope, campaign_name):
    cur.execute(
        """WITH current_batch AS (
               SELECT max(snapshot_at) AS snapshot_at
               FROM ads.entity_snapshot_batch
               WHERE account_id=%s AND status='COMPLETE'
           )
           SELECT current_batch.snapshot_at,
                  count(snapshot.entity_id)::integer AS candidate_count,
                  COALESCE(array_agg(snapshot.entity_id ORDER BY snapshot.entity_id)
                           FILTER (WHERE snapshot.entity_id IS NOT NULL),ARRAY[]::text[])
                      AS candidate_ids
           FROM current_batch
           LEFT JOIN ads.entity_snapshot snapshot
             ON snapshot.account_id=%s
            AND snapshot.snapshot_at=current_batch.snapshot_at
            AND snapshot.entity_type='CAMPAIGN'
            AND snapshot.name=%s
           GROUP BY current_batch.snapshot_at""",
        (scope,scope,campaign_name),
    )
    row=cur.fetchone() or {};snapshot_at=row.get("snapshot_at");candidate_ids=list(row.get("candidate_ids") or []);candidate_count=int(row.get("candidate_count") or 0)
    if snapshot_at is None:state="NO_COMPLETE_SNAPSHOT"
    elif candidate_count==0:state="NAME_MISSING"
    elif candidate_count==1:state="CURRENT_NAME_UNIQUE"
    else:state="NAME_CONFLICT"
    return snapshot_at,candidate_ids[0] if candidate_count==1 else None,candidate_count,state,candidate_ids


def _write_gross_invalid_rows(scope,rows,report_id,requested_start,requested_end):
    written=0
    with db.connect() as conn,conn.cursor() as cur:
        for ordinal,row in enumerate(rows,start=1):
            campaign_name=row.get("campaignName")
            snapshot_at,campaign_id,candidate_count,identity_state,candidate_ids=_campaign_name_identity(cur,scope,campaign_name)
            cur.execute("""INSERT INTO ads.gross_invalid_traffic_observation(account_id,report_id,source_row_ordinal,requested_start_date,requested_end_date,source_start_date,source_end_date,campaign_name,campaign_status,valid_impressions,valid_click_throughs,gross_impressions,invalid_impressions,source_invalid_impression_rate,gross_click_throughs,invalid_click_throughs,source_invalid_click_through_rate,identity_snapshot_at,resolved_campaign_id,identity_candidate_count,identity_state,identity_candidate_ids,source_record,ingested_at) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb,now()) ON CONFLICT(account_id,report_id,source_row_ordinal) DO UPDATE SET source_start_date=EXCLUDED.source_start_date,source_end_date=EXCLUDED.source_end_date,campaign_name=EXCLUDED.campaign_name,campaign_status=EXCLUDED.campaign_status,valid_impressions=EXCLUDED.valid_impressions,valid_click_throughs=EXCLUDED.valid_click_throughs,gross_impressions=EXCLUDED.gross_impressions,invalid_impressions=EXCLUDED.invalid_impressions,source_invalid_impression_rate=EXCLUDED.source_invalid_impression_rate,gross_click_throughs=EXCLUDED.gross_click_throughs,invalid_click_throughs=EXCLUDED.invalid_click_throughs,source_invalid_click_through_rate=EXCLUDED.source_invalid_click_through_rate,identity_snapshot_at=EXCLUDED.identity_snapshot_at,resolved_campaign_id=EXCLUDED.resolved_campaign_id,identity_candidate_count=EXCLUDED.identity_candidate_count,identity_state=EXCLUDED.identity_state,identity_candidate_ids=EXCLUDED.identity_candidate_ids,source_record=EXCLUDED.source_record,ingested_at=now()""",(scope,report_id,ordinal,requested_start,requested_end,row.get("startDate"),row.get("endDate"),campaign_name,row.get("campaignStatus"),_optional_int(row,"impressions"),_optional_int(row,"clicks"),_optional_int(row,"grossImpressions"),_optional_int(row,"invalidImpressions"),_optional_num(row,"invalidImpressionRate"),_optional_int(row,"grossClickThroughs"),_optional_int(row,"invalidClickThroughs"),_optional_num(row,"invalidClickThroughRate"),snapshot_at,campaign_id,candidate_count,identity_state,_json(candidate_ids),_json(row)));written+=1
        conn.commit()
    return written


def _refresh_daily_account(scope,start,end):
    with db.connect() as conn,conn.cursor() as cur:
        cur.execute("""INSERT INTO ads.daily_account(account_id,business_date,ad_product,impressions,clicks,spend,attributed_sales,purchases,units,currency,attribution_method,attribution_window,source_generated_at,ingested_at) SELECT account_id,business_date,%s,sum(impressions),sum(clicks),sum(spend),sum(attributed_sales),sum(purchases),sum(units),'MXN','click',%s,max(source_generated_at),now() FROM ads.daily_campaign WHERE account_id=%s AND business_date BETWEEN %s AND %s GROUP BY account_id,business_date ON CONFLICT(account_id,business_date,ad_product) DO UPDATE SET impressions=EXCLUDED.impressions,clicks=EXCLUDED.clicks,spend=EXCLUDED.spend,attributed_sales=EXCLUDED.attributed_sales,purchases=EXCLUDED.purchases,units=EXCLUDED.units,attribution_method=EXCLUDED.attribution_method,attribution_window=EXCLUDED.attribution_window,source_generated_at=EXCLUDED.source_generated_at,ingested_at=now()""",(AD_PRODUCT,ATTRIBUTION_WINDOW,scope,start,end));conn.commit()


def _next_window():
    yesterday=date.today()-timedelta(days=1);earliest=max(date(2025,10,1),date.today()-timedelta(days=min(settings.ads_backfill_days,MAX_BACKFILL_DAYS)));cursor=db.get_cursor(SOURCE,JOB,THROUGH_CURSOR)
    start=max(earliest,date.fromisoformat(cursor)+timedelta(days=1)) if cursor else earliest
    if start>yesterday:start=max(earliest,yesterday-timedelta(days=13))
    return start,min(yesterday,start+timedelta(days=30))


def _next_traffic_quality_window():
    yesterday=date.today()-timedelta(days=1);earliest=yesterday-timedelta(days=TRAFFIC_QUALITY_BACKFILL_DAYS-1);cursor=db.get_cursor(SOURCE,TRAFFIC_QUALITY_JOB,TRAFFIC_QUALITY_THROUGH_CURSOR)
    start=max(earliest,date.fromisoformat(cursor)+timedelta(days=1)) if cursor else earliest
    if start>yesterday:start=max(earliest,yesterday-timedelta(days=27))
    return start,min(yesterday,start+timedelta(days=30))


def ads_traffic_quality_backfill_complete():
    cursor=db.get_cursor(SOURCE,TRAFFIC_QUALITY_JOB,TRAFFIC_QUALITY_THROUGH_CURSOR)
    if not cursor:return False
    try:return date.fromisoformat(cursor)>=date.today()-timedelta(days=1)
    except ValueError:return False


def _publish_state(state, detail_code, **metadata):
    db.set_integration_state("amazon_ads", state, detail_code, metadata)


def _report_progress_callback(scope, grain, report_id, start, end, report_number, report_total, *, history_available=False):
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
        _publish_state(
            "READY" if history_available else "BACKFILL_RUNNING",
            "REPORT_REFRESH_RUNNING" if history_available else "REPORT_VENDOR_PROCESSING",
            **metadata,
        )

    return publish,metadata


def ads_backfill_complete():
    cursor = db.get_cursor(SOURCE, JOB, THROUGH_CURSOR)
    if not cursor:
        return False
    try:
        return date.fromisoformat(cursor) >= date.today() - timedelta(days=1)
    except ValueError:
        return False


def ads_initial_history_complete():
    """Return whether the one-time history load has ever reached current data.

    The versioned marker prevents each new reporting day from turning an ordinary
    incremental refresh back into an initial-backfill state. A report-contract
    change uses a new marker and through-date cursor so every retained day is
    rebuilt with the newly required source columns.
    """
    if db.get_cursor(SOURCE, JOB, INITIAL_HISTORY_CURSOR):
        return True
    cursor = db.get_cursor(SOURCE, JOB, THROUGH_CURSOR)
    if not cursor:
        return False
    try:
        return date.fromisoformat(cursor) >= date.today() - timedelta(days=2)
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
        elif ads_initial_history_complete():
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
    start,end=_next_window();client=AmazonAdsClient();history_available=ads_initial_history_complete();failure_context={"start_date":start.isoformat(),"end_date":end.isoformat()}
    try:
        _publish_state("READY" if history_available else "BACKFILL_RUNNING", "REPORT_REFRESH_RUNNING" if history_available else "REPORT_WINDOW_RUNNING", start=start.isoformat(), end=end.isoformat())
        scopes,discovery=discover_scopes(client)
        if not scopes:
            _publish_state("AUTHORIZATION_PENDING", "NO_MX_ADVERTISER_PROFILE")
            return {"status":"no_mx_profiles","window":[start.isoformat(),end.isoformat()],**discovery}
        with db.ingestion_run(SOURCE,JOB,{"start":start.isoformat(),"end":end.isoformat(),**discovery}) as run:
            total_read=total_written=0;report_ids=[];grains={"campaign":_write_campaign_rows,"product":_write_product_rows,"target":_write_target_rows,"search_term":_write_search_term_rows,"ad_group":_write_ad_group_rows,"placement":_write_placement_rows,"purchased_product":_write_purchased_product_rows}
            for scope in scopes:
                _ensure_account(scope);_ensure_required_grains(scope,start)
                for report_number,(grain,writer) in enumerate(grains.items(),start=1):
                    rid=client.create_report(scope,start,end,grain=grain);report_ids.append(rid);progress,failure_context=_report_progress_callback(scope,grain,rid,start,end,report_number,len(grains),history_available=history_available);progress("REQUESTED",{});status=client.wait_for_report(scope,rid,on_status=progress);location=status.get("url") or status.get("location")
                    if not location:raise RuntimeError(f"Amazon Ads report {rid} completed without download URL: {status}")
                    rows=client.download_report(str(location));total_read+=len(rows)
                    _record_report_content(scope,rid,grain,start,end,rows,status)
                    try:written=writer(scope,rows,rid)
                    except Exception as exc:raise RuntimeError(f"Amazon Ads write grain={grain} report_id={rid} failed: {exc}") from exc
                    total_written+=written
                    _record_report_run(scope,rid,grain,start,end,len(rows),status)
                _refresh_daily_account(scope,start,end)
            run["records_read"]=total_read;run["records_written"]=total_written
        db.set_cursor(SOURCE,JOB,end.isoformat(),THROUGH_CURSOR)
        backfill_complete = end >= date.today()-timedelta(days=1)
        if backfill_complete:
            db.set_cursor(SOURCE,JOB,end.isoformat(),INITIAL_HISTORY_CURSOR)
            _publish_state("READY", "REPORTING_CURRENT", accounts=len(scopes), through_date=end.isoformat())
        elif history_available:
            _publish_state("READY", "REPORT_REFRESH_RUNNING", accounts=len(scopes), through_date=end.isoformat())
        else:
            _publish_state("BACKFILL_RUNNING", "INITIAL_HISTORY_PENDING", accounts=len(scopes), through_date=end.isoformat())
        return {"status":"success","start":start.isoformat(),"end":end.isoformat(),"backfill_complete":backfill_complete,"accounts":len(scopes),"records_read":total_read,"records_written":total_written,"report_ids":report_ids,"grains":list(grains),"transport":REPORT_TRANSPORT,"report_contract_version":REPORT_CONTRACT_VERSION,"attribution_window":ATTRIBUTION_WINDOW}
    except Exception:
        _publish_state("READY" if history_available else "FAILED", "REPORT_REFRESH_FAILED" if history_available else "REPORT_INGESTION_FAILED", **failure_context)
        raise
    finally:client.close()


def ingest_ads_traffic_quality():
    """Collect the independent gross/invalid-traffic trust source.

    Amazon's proven MX response omits campaignId, so rows retain the exact source
    record and a conservative point-in-time name resolution. This collector has
    its own 365-day cursor and failure boundary; it cannot invalidate otherwise
    healthy Sponsored Products performance ingestion.
    """
    if not settings.ads_enabled:return {"status":"disabled"}
    if not settings.ads_credentials_present:return {"status":"missing_credentials"}
    start,end=_next_traffic_quality_window();client=AmazonAdsClient()
    try:
        scopes,discovery=discover_scopes(client)
        if not scopes:return {"status":"no_mx_profiles","window":[start.isoformat(),end.isoformat()],**discovery}
        with db.ingestion_run(SOURCE,TRAFFIC_QUALITY_JOB,{"start":start.isoformat(),"end":end.isoformat(),**discovery}) as run:
            total_read=total_written=0;report_ids=[]
            for scope in scopes:
                _ensure_account(scope)
                with db.connect() as conn,conn.cursor() as cur:
                    cur.execute("""INSERT INTO ads.required_report_grain(account_id,report_grain,ad_product,required,effective_from) VALUES(%s,'gross_invalid_traffic',%s,true,%s) ON CONFLICT(account_id,report_grain,ad_product,effective_from) DO UPDATE SET required=true""",(scope,AD_PRODUCT,start));conn.commit()
                rid=client.create_report(scope,start,end,grain="gross_invalid");report_ids.append(rid);status=client.wait_for_report(scope,rid);location=status.get("url") or status.get("location")
                if not location:raise RuntimeError(f"Amazon Ads report {rid} completed without download URL: {status}")
                rows=client.download_report(str(location));total_read+=len(rows)
                try:written=_write_gross_invalid_rows(scope,rows,rid,start,end)
                except Exception as exc:raise RuntimeError(f"Amazon Ads write grain=gross_invalid report_id={rid} failed: {exc}") from exc
                total_written+=written;_record_report_run(scope,rid,"gross_invalid_traffic",start,end,len(rows),status)
            run["records_read"]=total_read;run["records_written"]=total_written
        db.set_cursor(SOURCE,TRAFFIC_QUALITY_JOB,end.isoformat(),TRAFFIC_QUALITY_THROUGH_CURSOR)
        return {"status":"success","start":start.isoformat(),"end":end.isoformat(),"backfill_complete":end>=date.today()-timedelta(days=1),"accounts":len(scopes),"records_read":total_read,"records_written":total_written,"report_ids":report_ids,"grain":"gross_invalid_traffic","transport":REPORT_TRANSPORT}
    finally:client.close()
