from __future__ import annotations


CORE_STREAMS = (
    {
        "source": "amazon_spapi",
        "job_name": "orders_v2026",
        "label": "Orders",
        "domain": "Today",
    },
    {
        "source": "amazon_data_kiosk",
        "job_name": "sales_traffic_2024_04_24",
        "label": "Sales & Traffic",
        "domain": "Sales",
    },
    {
        "source": "amazon_reports",
        "job_name": "merchant_listings_all_data",
        "label": "Seller listings",
        "domain": "Products",
    },
    {
        "source": "amazon_spapi",
        "job_name": "catalog_items_2022_04_01",
        "label": "Catalog enrichment",
        "domain": "Products",
    },
    {
        "source": "amazon_spapi",
        "job_name": "fba_inventory_v1",
        "label": "FBA inventory",
        "domain": "Inventory",
    },
    {
        "source": "amazon_spapi",
        "job_name": "finances_v2024",
        "label": "Finance transactions",
        "domain": "Finance",
    },
)

DOMAIN_DEFINITIONS = (
    {"key": "today", "label": "Today", "critical": True},
    {"key": "sales", "label": "Sales", "critical": True},
    {"key": "products", "label": "Products", "critical": True},
    {"key": "inventory", "label": "Inventory", "critical": True},
    {"key": "finance", "label": "Finance", "critical": True},
)

SUPPORTING_STREAM_REASONS = {
    ("amazon_reports", "settlement_reports_v2"): "Supporting Finance settlement evidence; not one of the six primary decision-input pipelines.",
    ("amazon_spapi", "orders_geography_state_v2026"): "Supporting Sales geography enrichment; not one of the six primary decision-input pipelines.",
    ("dpp_finance", "month_close"): "Supporting Finance close evaluation; not one of the six primary decision-input pipelines.",
    ("amazon_ads", "sponsored_products_reporting_v3"): "Optional Ads reporting; excluded from the core count until Ads is configured and is always reported separately.",
}


def job_key(job: dict) -> tuple[str, str]:
    return (str(job.get("source") or ""), str(job.get("job_name") or ""))


def job_state(job: dict) -> str:
    status = str(job.get("latest_status") or "unknown").lower()
    if status == "error":
        return "failed"
    if job.get("is_stale"):
        return "stale"
    if status == "interrupted":
        return "degraded"
    if status in ("success", "running"):
        return "healthy"
    return "degraded"


def worst_state(states: list[str]) -> str:
    rank = {"failed": 5, "stale": 4, "degraded": 3, "disconnected": 2, "healthy": 1}
    return max(states or ["disconnected"], key=lambda state: rank.get(state, 3))


def build_health_contract(jobs: list[dict], catalog_summary: dict, ads_summary: dict) -> dict:
    jobs_by_key = {job_key(job): job for job in jobs}
    core_items = []
    for definition in CORE_STREAMS:
        key = (definition["source"], definition["job_name"])
        job = jobs_by_key.get(key)
        core_items.append(
            {
                **definition,
                "state": job_state(job) if job else "disconnected",
                "present": job is not None,
            }
        )

    core_keys = {(item["source"], item["job_name"]) for item in CORE_STREAMS}
    excluded_jobs = [
        {
            "source": job.get("source"),
            "job_name": job.get("job_name"),
            "label": job.get("label") or job.get("job_name"),
            "domain": job.get("domain") or "Warehouse",
            "state": job_state(job),
            "reason": SUPPORTING_STREAM_REASONS.get(
                job_key(job),
                "Supporting warehouse pipeline; visible in Data Health but outside the six primary decision-input pipelines.",
            ),
        }
        for job in jobs
        if job_key(job) not in core_keys
    ]

    active_conditions = [
        {
            "code": "CORE_PIPELINE_MISSING",
            "domain": item["domain"],
            "count": 1,
            "state": "disconnected",
            "label": item["label"],
        }
        for item in core_items
        if not item["present"]
    ]
    for job in jobs:
        state = job_state(job)
        if state != "healthy":
            active_conditions.append(
                {
                    "code": (
                        "CORE_PIPELINE_OUTSIDE_CONTRACT"
                        if job_key(job) in core_keys
                        else "SUPPORTING_PIPELINE_OUTSIDE_CONTRACT"
                    ),
                    "domain": job.get("domain") or "Warehouse",
                    "count": 1,
                    "state": state,
                    "label": job.get("label") or job.get("job_name") or "Unknown stream",
                }
            )

    source_attention = int(catalog_summary.get("source_attention") or 0)
    taxonomy_attention = int(catalog_summary.get("taxonomy_attention") or 0)
    if source_attention:
        active_conditions.append(
            {
                "code": "CATALOG_SOURCE_ATTENTION",
                "domain": "Products",
                "count": source_attention,
                "state": "failed",
                "label": "Overdue Amazon catalog source evidence",
            }
        )
    if taxonomy_attention:
        active_conditions.append(
            {
                "code": "CATALOG_TAXONOMY_ATTENTION",
                "domain": "Products",
                "count": taxonomy_attention,
                "state": "degraded",
                "label": "Seller taxonomy mapping",
            }
        )

    domains = []
    for definition in DOMAIN_DEFINITIONS:
        domain_jobs = [job for job in jobs if job.get("domain") == definition["label"]]
        states = [job_state(job) for job in domain_jobs]
        states.extend(
            condition["state"]
            for condition in active_conditions
            if condition["domain"] == definition["label"]
        )
        domains.append(
            {
                **definition,
                "state": worst_state(states),
                "job_count": len(domain_jobs),
                "condition_count": sum(
                    int(condition["count"])
                    for condition in active_conditions
                    if condition["domain"] == definition["label"]
                ),
            }
        )

    ads_state = str(ads_summary.get("state") or "AWAITING_DATA").upper()
    domains.append(
        {
            "key": "ads",
            "label": "Ads",
            "critical": False,
            "state": "healthy" if ads_state == "HEALTHY" else "degraded" if ads_state == "ATTENTION" else "disconnected",
            "job_count": sum(1 for job in jobs if job.get("domain") == "Ads"),
            "condition_count": int(ads_summary.get("attention_accounts") or 0),
        }
    )

    active_condition_count = sum(int(condition["count"]) for condition in active_conditions)
    affected_domains = sorted(
        {condition["domain"] for condition in active_conditions},
        key=lambda label: [item["label"] for item in DOMAIN_DEFINITIONS].index(label)
        if label in [item["label"] for item in DOMAIN_DEFINITIONS]
        else len(DOMAIN_DEFINITIONS),
    )
    healthy_core = sum(1 for item in core_items if item["state"] == "healthy")

    return {
        "contract_id": "BUSINESS_DECISION_HEALTH_V1",
        "pipeline_scope": {
            "label": "Core decision-input pipelines",
            "healthy": healthy_core,
            "total": len(core_items),
            "attention": len(core_items) - healthy_core,
            "included": core_items,
            "excluded": excluded_jobs,
            "exclusion_rule": "Supporting jobs and optional Ads remain visible in Data Health but do not change the six-stream core pipeline denominator.",
        },
        "conditions": {
            "active_count": active_condition_count,
            "active": active_conditions,
            "excluded": [
                {
                    "code": "CATALOG_ONBOARDING_GRACE",
                    "count": int(catalog_summary.get("onboarding") or 0),
                    "reason": "Normal Amazon propagation inside the documented 48-hour grace period is informational, not degradation.",
                },
                {
                    "code": "ADS_AWAITING_DATA",
                    "count": 1 if ads_state == "AWAITING_DATA" else 0,
                    "reason": "Ads is optional while authorization or reporting data is unavailable and is reported separately.",
                },
            ],
        },
        "domains": domains,
        "overall": {
            "state": worst_state(
                [domain["state"] for domain in domains if domain["critical"]]
            ),
            "active_condition_count": active_condition_count,
            "affected_domains": affected_domains,
        },
    }
