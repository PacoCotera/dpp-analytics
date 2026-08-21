from __future__ import annotations


def _one(cur, sql: str, params=()):
    cur.execute(sql, params)
    return cur.fetchone() or {}


def _all(cur, sql: str, params=()):
    cur.execute(sql, params)
    return list(cur.fetchall())


def trajectory_payload(connect, marketplace: str) -> dict:
    with connect() as conn, conn.cursor() as cur:
        cutoff = _one(cur,"""SELECT max(business_date) AS d FROM mart.business_daily WHERE marketplace_id=%s AND reconciled_daily_report""",(marketplace,)).get("d")
        if cutoff is None:
            return {"headline": {}, "horizons": [], "series": [], "weekly": [], "ads": {"status":"awaiting_ads_data"}, "local_time": None}

        horizons=[]
        for label,days in (("7D",7),("28D",28),("56D",56),("90D",90)):
            row=_one(cur,"""
                WITH c AS (SELECT %s::date d), x AS (
                  SELECT COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.d-(%s-1) AND c.d),0)::numeric(14,2) sales,
                    COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.d-(%s*2-1) AND c.d-%s),0)::numeric(14,2) prior_sales,
                    COALESCE(sum(orders) FILTER (WHERE business_date BETWEEN c.d-(%s-1) AND c.d),0)::bigint orders,
                    COALESCE(sum(units) FILTER (WHERE business_date BETWEEN c.d-(%s-1) AND c.d),0)::bigint units
                  FROM mart.business_daily,c WHERE marketplace_id=%s AND business_date BETWEEN c.d-(%s*2-1) AND c.d)
                SELECT sales,prior_sales,orders,units,round(sales/%s::numeric,2) daily_avg,
                  CASE WHEN prior_sales>0 THEN round(100.0*(sales-prior_sales)/prior_sales,1) END delta_pct FROM x
            """,(cutoff,days,days,days,days,days,marketplace,days,days))
            row["label"]=label; horizons.append(row)

        headline={"business_date":cutoff,"sales_t28":horizons[1].get("sales"),"delta28_pct":horizons[1].get("delta_pct"),"daily_avg_t28":horizons[1].get("daily_avg"),"delta90_pct":horizons[3].get("delta_pct")}
        series=_all(cur,"""SELECT business_date,sales,avg(sales) OVER (PARTITION BY marketplace_id ORDER BY business_date ROWS BETWEEN 27 PRECEDING AND CURRENT ROW)::numeric(14,2) avg28 FROM mart.business_daily WHERE marketplace_id=%s AND business_date BETWEEN %s::date-179 AND %s::date ORDER BY business_date""",(marketplace,cutoff,cutoff))
        weekly=_all(cur,"""
            WITH c AS (SELECT %s::date cutoff,date_trunc('week',%s::date)::date current_week_start), d AS (
              SELECT business_date,sales FROM mart.business_daily,c WHERE marketplace_id=%s AND business_date BETWEEN c.cutoff-104 AND c.cutoff AND reconciled_daily_report), w AS (
              SELECT date_trunc('week',business_date)::date week_start,(date_trunc('week',business_date)::date+6) week_end,extract(week FROM business_date)::int iso_week,count(*)::int days_loaded,sum(sales)::numeric(14,2) sales,round(avg(sales),2) daily_avg FROM d GROUP BY 1,2,3), enriched AS (
              SELECT w.*,lag(w.sales) OVER (ORDER BY w.week_start) prior_week_sales,c.cutoff,c.current_week_start,(w.week_start=c.current_week_start) current_week,(w.week_end<=c.cutoff) complete_week FROM w CROSS JOIN c)
            SELECT *,CASE WHEN prior_week_sales>0 AND complete_week THEN round(100.0*(sales-prior_week_sales)/prior_week_sales,1) END delta_vs_prior_week_pct,
              CASE WHEN current_week THEN ('through '||to_char(cutoff,'Dy Mon DD')) ELSE (to_char(week_start,'Mon DD')||' – '||to_char(week_end,'Mon DD')) END date_range FROM enriched ORDER BY week_start DESC LIMIT 10
        """,(cutoff,cutoff,marketplace))

        ads=_one(cur,"""SELECT business_date through_date,spend,attributed_sales,impressions,clicks,purchases,units,ctr,cpc,roas,acos,tacos,attribution_maturity,source_freshness FROM mart.ads_business_t28 WHERE marketplace_id=%s ORDER BY business_date DESC LIMIT 1""",(marketplace,))
        ads["status"]="ready" if ads else "awaiting_ads_data"
        ads["interpretation"]="Amazon-attributed sales are attribution, not incremental sales. TACOS uses independently reconciled seller sales; total sales minus attributed sales is not exact organic sales."
        ads_daily=_all(cur,"""SELECT business_date,spend,attributed_sales,roas,acos,tacos,attribution_maturity FROM mart.ads_business_daily WHERE marketplace_id=%s AND business_date BETWEEN %s::date-89 AND %s::date ORDER BY business_date""",(marketplace,cutoff,cutoff))
        local_clock=_one(cur,"SELECT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'America/Mexico_City','HH24:MI') local_time")

    return {"headline":headline,"horizons":horizons,"series":series,"weekly":weekly,"ads":ads,"ads_daily":ads_daily,"local_time":local_clock.get("local_time")}
