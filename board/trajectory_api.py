from __future__ import annotations

from interpretation_rules import rule_catalog, trajectory_structure
from metric_windows import RECONCILED_BUSINESS_T28, load_metric_windows


def _one(cur, sql: str, params=()):
    cur.execute(sql, params)
    return cur.fetchone() or {}


def _all(cur, sql: str, params=()):
    cur.execute(sql, params)
    return list(cur.fetchall())


def trajectory_payload(connect, marketplace: str) -> dict:
    with connect() as conn, conn.cursor() as cur:
        market = _one(cur,"SELECT timezone,currency FROM core.marketplace WHERE marketplace_id=%s",(marketplace,))
        timezone = market.get("timezone") or "America/Mexico_City"
        cutoff = _one(cur,"""SELECT max(business_date) AS d FROM mart.business_daily WHERE marketplace_id=%s AND reconciled_daily_report""",(marketplace,)).get("d")
        if cutoff is None:
            return {"headline": {}, "horizons": [], "series": [], "weekly": [], "portfolio": {}, "ads": {"status":"awaiting_ads_data"}, "local_time": None}

        horizons=[]
        for label,days in (("7D",7),("28D",28),("56D",56),("90D",90)):
            row=_one(cur,"""
                WITH c AS (SELECT %s::date d), x AS (
                  SELECT COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.d-(%s-1) AND c.d),0)::numeric(14,2) sales,
                    COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.d-(%s*2-1) AND c.d-%s),0)::numeric(14,2) prior_sales,
                    COALESCE(sum(orders) FILTER (WHERE business_date BETWEEN c.d-(%s-1) AND c.d),0)::bigint orders,
                    COALESCE(sum(units) FILTER (WHERE business_date BETWEEN c.d-(%s-1) AND c.d),0)::bigint units
                  FROM mart.business_daily,c
                  WHERE marketplace_id=%s AND reconciled_daily_report
                    AND business_date BETWEEN c.d-(%s*2-1) AND c.d)
                SELECT sales,prior_sales,orders,units,round(sales/%s::numeric,2) daily_avg,
                  CASE WHEN prior_sales>0 THEN round(100.0*(sales-prior_sales)/prior_sales,1) END delta_pct FROM x
            """,(cutoff,days,days,days,days,days,marketplace,days,days))
            row["label"]=label; horizons.append(row)

        headline={"business_date":cutoff,"sales_t28":horizons[1].get("sales"),"delta28_pct":horizons[1].get("delta_pct"),"daily_avg_t28":horizons[1].get("daily_avg"),"delta90_pct":horizons[3].get("delta_pct")}
        series=_all(cur,"""
            SELECT business_date,sales,
              avg(sales) OVER (PARTITION BY marketplace_id ORDER BY business_date ROWS BETWEEN 27 PRECEDING AND CURRENT ROW)::numeric(14,2) avg28
            FROM mart.business_daily
            WHERE marketplace_id=%s AND reconciled_daily_report
              AND business_date BETWEEN least(date_trunc('year',%s::date)::date,%s::date-179) AND %s::date
            ORDER BY business_date
        """,(marketplace,cutoff,cutoff,cutoff))
        weekly=_all(cur,"""
            WITH c AS (SELECT %s::date cutoff,date_trunc('week',%s::date)::date current_week_start), d AS (
              SELECT business_date,sales FROM mart.business_daily,c WHERE marketplace_id=%s AND business_date BETWEEN c.cutoff-104 AND c.cutoff AND reconciled_daily_report), w AS (
              SELECT date_trunc('week',business_date)::date week_start,(date_trunc('week',business_date)::date+6) week_end,extract(week FROM business_date)::int iso_week,count(*)::int days_loaded,sum(sales)::numeric(14,2) sales,round(avg(sales),2) daily_avg FROM d GROUP BY 1,2,3), enriched AS (
              SELECT w.*,lag(w.sales) OVER (ORDER BY w.week_start) prior_week_sales,c.cutoff,c.current_week_start,(w.week_start=c.current_week_start) current_week,(w.week_end<=c.cutoff) complete_week FROM w CROSS JOIN c)
            SELECT *,CASE WHEN prior_week_sales>0 AND complete_week THEN round(100.0*(sales-prior_week_sales)/prior_week_sales,1) END delta_vs_prior_week_pct,
              CASE WHEN current_week THEN ('through '||to_char(cutoff,'Dy Mon DD')) ELSE (to_char(week_start,'Mon DD')||' – '||to_char(week_end,'Mon DD')) END date_range FROM enriched ORDER BY week_start DESC LIMIT 10
        """,(cutoff,cutoff,marketplace))

        portfolio=_one(cur,"""
            WITH offers AS (
              SELECT seller_sku,asin,open_date,COALESCE(sales_t28,0)::numeric AS sales_t28,
                     COALESCE(units_t28,0)::numeric AS units_t28
              FROM mart.catalog_portfolio_product
              WHERE marketplace_id=%s
                AND is_offer_owner
                AND product_role IN ('SELLABLE_VARIATION','SELLABLE_STANDALONE')
                AND lower(COALESCE(status,'')) <> 'inactive'
            ), ranked AS (
              SELECT *,row_number() OVER (ORDER BY sales_t28 DESC,seller_sku) AS revenue_rank
              FROM offers
            ), agg AS (
              SELECT count(*)::int AS active_skus,
                     count(*) FILTER (WHERE units_t28>0)::int AS productive_skus,
                     COALESCE(sum(sales_t28),0)::numeric(14,2) AS portfolio_sales_t28,
                     COALESCE(avg(sales_t28),0)::numeric(14,2) AS revenue_per_active_sku,
                     COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY sales_t28),0)::numeric(14,2) AS median_revenue_per_sku,
                     COALESCE(sum(sales_t28) FILTER (WHERE revenue_rank=1),0)::numeric(14,2) AS top1_sales,
                     COALESCE(sum(sales_t28) FILTER (WHERE revenue_rank<=3),0)::numeric(14,2) AS top3_sales,
                     COALESCE(sum(sales_t28) FILTER (WHERE open_date IS NOT NULL AND open_date>=%s::date-89),0)::numeric(14,2) AS new_sku_sales
              FROM ranked
            )
            SELECT active_skus,productive_skus,portfolio_sales_t28,revenue_per_active_sku,median_revenue_per_sku,
                   CASE WHEN portfolio_sales_t28>0 THEN round(100.0*top1_sales/portfolio_sales_t28,1) END AS top_sku_share_pct,
                   CASE WHEN portfolio_sales_t28>0 THEN round(100.0*top3_sales/portfolio_sales_t28,1) END AS top3_share_pct,
                   CASE WHEN portfolio_sales_t28>0 THEN round(100.0*new_sku_sales/portfolio_sales_t28,1) END AS new_sku_share_pct
            FROM agg
        """,(marketplace,cutoff))
        portfolio["definition"]={
            "identity":"Canonical active sellable offer owners only; structural parents and seller-SKU aliases are excluded.",
            "productive_sku":"An active sellable offer with at least one unit in the latest reconciled 28 days.",
            "new_sku":"An active sellable offer whose Amazon open_date is within the latest 90 days.",
            "shares":"Top-SKU, top-3 and new-SKU shares use current T28 seller sales as the denominator."
        }

        ads=_one(cur,"""
            SELECT through_date,spend,attributed_sales,impressions,clicks,
              attributed_purchases purchases,attributed_units units,ctr,cpc,roas,acos,tacos,
              CASE WHEN observed_ads_days>0 AND mature_ads_days=observed_ads_days THEN 'MATURE' ELSE 'PROVISIONAL' END attribution_maturity,
              ads_ingested_at source_freshness
            FROM mart.ads_business_t28
            WHERE marketplace_id=%s
            ORDER BY through_date DESC LIMIT 1
        """,(marketplace,))
        ads["status"]="ready" if ads else "awaiting_ads_data"
        ads["interpretation"]="Amazon-attributed sales are attribution, not incremental sales. TACOS uses independently reconciled seller sales; total sales minus attributed sales is not exact organic sales."
        ads_daily=_all(cur,"""
            SELECT business_date,ad_spend spend,attributed_sales,roas,acos,tacos,attribution_state attribution_maturity
            FROM mart.ads_business_daily
            WHERE marketplace_id=%s AND business_date BETWEEN %s::date-89 AND %s::date
            ORDER BY business_date
        """,(marketplace,cutoff,cutoff))
        local_clock=_one(cur,"SELECT to_char(CURRENT_TIMESTAMP AT TIME ZONE %s,'HH24:MI') local_time",(timezone,))
        metric_windows = load_metric_windows(
            cur,
            marketplace,
            (RECONCILED_BUSINESS_T28,),
            timezone=timezone,
        )

    trajectory_read = trajectory_structure(horizons)
    return {
        "headline":headline,"horizons":horizons,"series":series,"weekly":weekly,
        "portfolio":portfolio,"ads":ads,"ads_daily":ads_daily,"local_time":local_clock.get("local_time"),
        "trajectory_read":trajectory_read,"interpretation_rules":rule_catalog("TRAJECTORY_STRUCTURE_V1"),
        "metric_windows":metric_windows,
        "metric_basis":{
            "currency":market.get("currency") or "MXN",
            "historical_sales":{"id":"AMAZON_ORDERED_PRODUCT_SALES","source":"Sales & Traffic / Data Kiosk","reconciled_only":True},
        },
    }
