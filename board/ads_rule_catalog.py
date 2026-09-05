from __future__ import annotations


# These thresholds remain observational V1 behavior during Batch 2. They do
# not authorize capital changes and are not promoted into the V2 catalog.
WINDOW_DAYS = 28
MIN_SIGNAL_CLICKS = 8
MIN_REPEAT_PURCHASES = 2
MIN_PRODUCT_OBSERVED_DAYS = 14
SEARCH_QUERY_LIMIT = 8
SEARCH_QUERY_MIN_IMPRESSIONS = 100
SEARCH_QUERY_MIN_CLICKS = 8
SEARCH_QUERY_MIN_CART_ADDS = 3
SEARCH_QUERY_MIN_VOLUME = 1000
SEARCH_QUERY_MAX_VISIBILITY_SHARE = 0.01
SEARCH_QUERY_RATE_RATIO = 0.75
SEARCH_QUERY_SCENARIO_LOW = 0.25
SEARCH_QUERY_SCENARIO_HIGH = 0.50

SEARCH_OPPORTUNITY_RULES = {
    "SQP_PURCHASE_GAP": {
        "key": "SQP_PURCHASE_GAP",
        "version": 1,
        "label": "Purchase gap",
        "minimum_evidence": {"asin_cart_adds": SEARCH_QUERY_MIN_CART_ADDS},
        "comparison": "ASIN purchases per cart add are below 75% of the Amazon-wide query rate.",
        "review": "Review offer availability, price, delivery promise and purchase friction.",
    },
    "SQP_CART_GAP": {
        "key": "SQP_CART_GAP",
        "version": 1,
        "label": "Cart gap",
        "minimum_evidence": {"asin_clicks": SEARCH_QUERY_MIN_CLICKS},
        "comparison": "ASIN cart adds per click are below 75% of the Amazon-wide query rate.",
        "review": "Review product-page fit, value communication, price and query promise.",
    },
    "SQP_CLICK_GAP": {
        "key": "SQP_CLICK_GAP",
        "version": 1,
        "label": "Click gap",
        "minimum_evidence": {"asin_impressions": SEARCH_QUERY_MIN_IMPRESSIONS},
        "comparison": "ASIN clicks per impression are below 75% of the Amazon-wide query rate.",
        "review": (
            "Confirm query-product relevance first. If it fits, review title, main image, price and delivery promise."
        ),
    },
    "SQP_VISIBILITY_REVIEW": {
        "key": "SQP_VISIBILITY_REVIEW",
        "version": 1,
        "label": "Visibility review",
        "minimum_evidence": {
            "search_query_volume": SEARCH_QUERY_MIN_VOLUME,
            "total_query_impressions": SEARCH_QUERY_MIN_VOLUME,
        },
        "comparison": "ASIN impression share is below 1% for a query with meaningful demand.",
        "review": "Check relevance and indexing, then consider a controlled paid-search test if the query fits.",
    },
}

ECONOMICS_CONTRACT = {
    "state": "UNAVAILABLE",
    "authoritative": False,
    "basis": (
        "Product economics are not yet reconciled for Advertising decisions. "
        "Review contribution in Finance before changing paid support."
    ),
    "missing_inputs": [
        "selling price and IVA basis",
        "Amazon commission and fulfillment fees",
        "current product COGS",
        "returns and refunds",
        "advertising allocation",
    ],
    "prohibited_claims": ["profitable", "scale", "winner", "reduce spend"],
}

INTERPRETATION_RULES = {
    "ADS_PRODUCT_CONVERSION_REVIEW": {
        "key": "ADS_PRODUCT_CONVERSION_REVIEW",
        "version": 1,
        "title": "Product conversion review",
        "eligibility": (
            "The product has at least 14 observed advertising days, its eligible attribution days are mature, "
            "and the reporting window passes reconciliation."
        ),
        "thresholds": {
            "minimum_clicks": MIN_SIGNAL_CLICKS,
            "maximum_attributed_purchases": 0,
            "minimum_observed_days": MIN_PRODUCT_OBSERVED_DAYS,
        },
        "observation_window": {"kind": "rolling", "days": WINDOW_DAYS},
        "attribution_maturity": "All observed days outside the declared attribution lookback must be mature.",
        "required_economic_inputs": [],
        "economic_claims_allowed": False,
        "plain_language": (
            "Enough shoppers clicked to warrant a listing and relevance review, but Amazon reports no attributed purchase."
        ),
        "evidence_fields": ["clicks", "attributed_purchases", "spend", "observed_ads_days", "mature_ads_days"],
    },
    "ADS_PRODUCT_DEMAND_REVIEW": {
        "key": "ADS_PRODUCT_DEMAND_REVIEW",
        "version": 1,
        "title": "Product demand review",
        "eligibility": (
            "The product has at least 14 observed advertising days, its eligible attribution days are mature, "
            "and the reporting window passes reconciliation."
        ),
        "thresholds": {"minimum_attributed_purchases": MIN_REPEAT_PURCHASES},
        "observation_window": {"kind": "rolling", "days": WINDOW_DAYS},
        "attribution_maturity": "All observed days outside the declared attribution lookback must be mature.",
        "required_economic_inputs": [],
        "economic_claims_allowed": False,
        "plain_language": "Repeated attributed purchases justify reviewing the product's converting demand, not a scaling claim.",
        "evidence_fields": ["attributed_purchases", "attributed_sales", "spend", "observed_ads_days", "mature_ads_days"],
    },
    "ADS_DEMAND_TEST": {
        "key": "ADS_DEMAND_TEST",
        "version": 1,
        "title": "Demand test opportunity",
        "eligibility": (
            "The business reporting window is reconciled, its eligible attribution days are mature, and the signal is a "
            "recognizable shopper query, matched product or configured target."
        ),
        "thresholds": {"minimum_attributed_purchases": MIN_REPEAT_PURCHASES},
        "observation_window": {"kind": "rolling", "days": WINDOW_DAYS},
        "attribution_maturity": "At least 21 of 28 days are mature for the current seven-day attribution contract.",
        "required_economic_inputs": [],
        "economic_claims_allowed": False,
        "plain_language": "Repeated attributed purchases make the signal worth a controlled targeting review.",
        "evidence_fields": ["signal", "attributed_purchases", "attributed_sales", "spend", "campaign_id"],
    },
    "ADS_SIGNAL_RELEVANCE_REVIEW": {
        "key": "ADS_SIGNAL_RELEVANCE_REVIEW",
        "version": 1,
        "title": "Demand relevance review",
        "eligibility": "The business reporting window is reconciled and its eligible attribution days are mature.",
        "thresholds": {"minimum_clicks": MIN_SIGNAL_CLICKS, "maximum_attributed_purchases": 0},
        "observation_window": {"kind": "rolling", "days": WINDOW_DAYS},
        "attribution_maturity": "At least 21 of 28 days are mature for the current seven-day attribution contract.",
        "required_economic_inputs": [],
        "economic_claims_allowed": False,
        "plain_language": "Click activity without an attributed purchase warrants a relevance review, not an automatic bid change.",
        "evidence_fields": ["signal", "clicks", "attributed_purchases", "spend", "campaign_id"],
    },
    "ADS_SUPPORTED_MONITOR": {
        "key": "ADS_SUPPORTED_MONITOR",
        "version": 1,
        "title": "Supported product monitoring",
        "eligibility": "The product has advertising spend but no stronger review signal is eligible.",
        "thresholds": {"minimum_spend": 0},
        "observation_window": {"kind": "rolling", "days": WINDOW_DAYS},
        "attribution_maturity": "Maturity is reported with the product and may qualify the monitoring state.",
        "required_economic_inputs": [],
        "economic_claims_allowed": False,
        "plain_language": "Keep the product under observation while attribution matures or evidence remains limited.",
        "evidence_fields": ["spend", "clicks", "attributed_purchases", "observed_ads_days", "mature_ads_days"],
    },
    "ADS_INVENTORY_EXPOSURE_REVIEW": {
        "key": "ADS_INVENTORY_EXPOSURE_REVIEW",
        "version": 1,
        "title": "Paid-support inventory review",
        "eligibility": (
            "The record is a current commercial offer, Inventory has assigned STOCKOUT, PRODUCE or PLAN, "
            "paid support is active, and the reporting window passes reconciliation and attribution maturity."
        ),
        "thresholds": {
            "inventory_actions": ["STOCKOUT", "PRODUCE", "PLAN"],
            "minimum_spend_exclusive": 0,
            "minimum_observed_days": MIN_PRODUCT_OBSERVED_DAYS,
        },
        "observation_window": {"kind": "rolling", "days": WINDOW_DAYS},
        "attribution_maturity": "All observed days outside the declared attribution lookback must be mature.",
        "required_economic_inputs": [],
        "economic_claims_allowed": False,
        "plain_language": (
            "Active paid support and a current inventory constraint require a fulfillment-readiness review. "
            "The rule does not prescribe a bid, budget, pause or spend change."
        ),
        "evidence_fields": [
            "inventory_action",
            "available",
            "inbound",
            "days_cover_with_inbound",
            "spend",
            "observed_ads_days",
            "mature_ads_days",
        ],
    },
}


TARGET_DECISION_CATALOG = {
    "ADS_DATA_BLOCKER": ("PROTECT", "INVESTIGATE"),
    "ADS_INVENTORY_CONFLICT": ("PROTECT", "INVESTIGATE"),
    "ADS_ECONOMIC_LEAKAGE": ("PROTECT", "INVESTIGATE"),
    "ADS_QUERY_LEAKAGE": ("ELIMINATE", "INVESTIGATE"),
    "ADS_PRODUCT_CONVERSION_GAP": ("ELIMINATE", "INVESTIGATE"),
    "ADS_SQP_VISIBILITY_GAP": ("CAPTURE", "INVESTIGATE"),
    "ADS_SQP_CLICK_GAP": ("CAPTURE", "INVESTIGATE"),
    "ADS_SQP_CART_GAP": ("CAPTURE", "INVESTIGATE"),
    "ADS_SQP_PURCHASE_GAP": ("CAPTURE", "INVESTIGATE"),
    "ADS_QUERY_TEST": ("CAPTURE", "TEST"),
    "ADS_BUDGET_CONSTRAINT": ("ALLOCATE", "TEST"),
    "ADS_PRODUCT_ALLOCATION_TEST": ("ALLOCATE", "TEST"),
    "ADS_EXPERIMENT_EVALUATION": ("LEARN", "INVESTIGATE"),
}
