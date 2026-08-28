from __future__ import annotations

import unittest

from health_contract import CORE_STREAMS, build_health_contract


def healthy_core_jobs() -> list[dict]:
    return [
        {
            **definition,
            "latest_status": "success",
            "is_stale": False,
        }
        for definition in CORE_STREAMS
    ]


def domain(contract: dict, label: str) -> dict:
    return next(item for item in contract["domains"] if item["label"] == label)


class HealthContractTest(unittest.TestCase):
    def test_catalog_condition_is_visible_beside_healthy_six_stream_scope(self):
        jobs = healthy_core_jobs() + [
            {
                "source": "amazon_reports",
                "job_name": "settlement_reports_v2",
                "label": "Settlement reports",
                "domain": "Finance",
                "latest_status": "success",
                "is_stale": False,
            },
            {
                "source": "amazon_spapi",
                "job_name": "orders_geography_state_v2026",
                "label": "Order geography",
                "domain": "Sales",
                "latest_status": "success",
                "is_stale": False,
            },
            {
                "source": "dpp_finance",
                "job_name": "month_close",
                "label": "Finance month close",
                "domain": "Finance",
                "latest_status": "success",
                "is_stale": False,
            },
        ]

        contract = build_health_contract(
            jobs,
            {"source_attention": 0, "taxonomy_attention": 1, "onboarding": 0},
            {"state": "AWAITING_DATA"},
        )

        self.assertEqual(contract["pipeline_scope"]["healthy"], 6)
        self.assertEqual(contract["pipeline_scope"]["total"], 6)
        self.assertEqual(
            [item["label"] for item in contract["pipeline_scope"]["included"]],
            [item["label"] for item in CORE_STREAMS],
        )
        self.assertEqual(len(contract["pipeline_scope"]["excluded"]), 3)
        self.assertEqual(contract["overall"]["state"], "degraded")
        self.assertEqual(contract["overall"]["active_condition_count"], 1)
        self.assertEqual(contract["overall"]["affected_domains"], ["Products"])
        self.assertEqual(domain(contract, "Products")["state"], "degraded")

    def test_core_pipeline_failure_changes_scope_and_domain_state(self):
        jobs = healthy_core_jobs()
        finance = next(job for job in jobs if job["job_name"] == "finances_v2024")
        finance["latest_status"] = "error"

        contract = build_health_contract(
            jobs,
            {"source_attention": 0, "taxonomy_attention": 0, "onboarding": 0},
            {"state": "AWAITING_DATA"},
        )

        self.assertEqual(contract["pipeline_scope"]["healthy"], 5)
        self.assertEqual(contract["pipeline_scope"]["attention"], 1)
        self.assertEqual(contract["overall"]["state"], "failed")
        self.assertEqual(contract["overall"]["active_condition_count"], 1)
        self.assertEqual(domain(contract, "Finance")["state"], "failed")

    def test_catalog_source_gap_is_a_failed_product_condition(self):
        contract = build_health_contract(
            healthy_core_jobs(),
            {"source_attention": 2, "taxonomy_attention": 0, "onboarding": 0},
            {"state": "AWAITING_DATA"},
        )

        self.assertEqual(contract["pipeline_scope"]["healthy"], 6)
        self.assertEqual(contract["overall"]["active_condition_count"], 2)
        self.assertEqual(contract["overall"]["state"], "failed")
        self.assertEqual(contract["overall"]["affected_domains"], ["Products"])
        self.assertEqual(domain(contract, "Products")["state"], "failed")

    def test_missing_core_pipeline_fails_closed(self):
        jobs = [job for job in healthy_core_jobs() if job["job_name"] != "orders_v2026"]

        contract = build_health_contract(
            jobs,
            {"source_attention": 0, "taxonomy_attention": 0, "onboarding": 0},
            {"state": "AWAITING_DATA"},
        )

        self.assertEqual(contract["pipeline_scope"]["healthy"], 5)
        self.assertEqual(contract["overall"]["state"], "disconnected")
        self.assertEqual(contract["overall"]["affected_domains"], ["Today"])
        self.assertEqual(domain(contract, "Today")["state"], "disconnected")

    def test_supporting_job_failure_is_not_hidden_by_core_denominator(self):
        jobs = healthy_core_jobs() + [
            {
                "source": "amazon_reports",
                "job_name": "settlement_reports_v2",
                "label": "Settlement reports",
                "domain": "Finance",
                "latest_status": "error",
                "is_stale": False,
            }
        ]

        contract = build_health_contract(
            jobs,
            {"source_attention": 0, "taxonomy_attention": 0, "onboarding": 0},
            {"state": "AWAITING_DATA"},
        )

        self.assertEqual(contract["pipeline_scope"]["healthy"], 6)
        self.assertEqual(contract["pipeline_scope"]["total"], 6)
        self.assertEqual(contract["overall"]["state"], "failed")
        self.assertEqual(contract["overall"]["affected_domains"], ["Finance"])
        self.assertEqual(contract["pipeline_scope"]["excluded"][0]["state"], "failed")

    def test_onboarding_grace_and_unconfigured_ads_are_explicitly_excluded(self):
        contract = build_health_contract(
            healthy_core_jobs(),
            {"source_attention": 0, "taxonomy_attention": 0, "onboarding": 2},
            {"state": "AWAITING_DATA"},
        )

        self.assertEqual(contract["overall"]["state"], "healthy")
        self.assertEqual(contract["overall"]["active_condition_count"], 0)
        excluded = {item["code"]: item for item in contract["conditions"]["excluded"]}
        self.assertEqual(excluded["CATALOG_ONBOARDING_GRACE"]["count"], 2)
        self.assertEqual(excluded["ADS_AWAITING_DATA"]["count"], 1)
        self.assertEqual(domain(contract, "Ads")["state"], "disconnected")
        self.assertFalse(domain(contract, "Ads")["critical"])


if __name__ == "__main__":
    unittest.main()
