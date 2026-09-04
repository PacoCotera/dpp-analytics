from __future__ import annotations

import unittest
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from .amazon_ads_entities import (
    ENTITY_CONFIGS,
    _entity_values,
    _request_page,
    ingest_ads_entities,
)


def _response(status_code: int, payload: dict):
    response = MagicMock()
    response.status_code = status_code
    response.json.return_value = payload
    response.text = "error"
    response.content = b"{}"
    response.headers = {}
    return response


@contextmanager
def _run_context(_source, _job, _metadata):
    yield {"id": 77, "records_read": 0, "records_written": 0}


class AmazonAdsEntitySnapshotTests(unittest.TestCase):
    def test_manifest_covers_every_required_configuration_entity(self) -> None:
        self.assertEqual(
            {config[0] for config in ENTITY_CONFIGS},
            {"CAMPAIGN", "AD_GROUP", "PRODUCT_AD", "TARGET", "KEYWORD"},
        )

    def test_entity_values_preserve_budget_bid_identity_and_serving_state(self) -> None:
        values = _entity_values(
            "CAMPAIGN",
            {
                "campaignId": "campaign-1",
                "name": "Campaign",
                "state": "ENABLED",
                "budget": {"budget": "123.45", "budgetType": "DAILY_BUDGET"},
                "targetingType": "MANUAL",
                "portfolioId": "portfolio-1",
                "dynamicBidding": {
                    "strategy": "LEGACY_FOR_SALES",
                    "placementBidding": [{"placement": "PLACEMENT_TOP", "percentage": 50}],
                },
                "extendedData": {
                    "servingStatus": "CAMPAIGN_STATUS_ENABLED",
                    "servingStatusDetails": [{"name": "ELIGIBLE"}],
                    "creationDateTime": "2026-01-01T00:00:00Z",
                    "lastUpdateDateTime": "2026-02-01T00:00:00Z",
                },
            },
        )

        self.assertEqual(str(values["budget"]), "123.45")
        self.assertEqual(values["budget_type"], "DAILY_BUDGET")
        self.assertEqual(values["bidding_strategy"], "LEGACY_FOR_SALES")
        self.assertEqual(values["serving_status"], "CAMPAIGN_STATUS_ENABLED")

    @patch("dpp_analytics.amazon_ads_entities.time.sleep")
    def test_request_retries_throttling_and_paginates_in_request_body(self, sleep) -> None:
        client = MagicMock()
        client.base = "https://ads.example"
        client.authenticated_request.side_effect = [
            _response(429, {}),
            _response(200, {"campaigns": [], "nextToken": "next"}),
        ]

        payload = _request_page(
            client,
            "profile-1",
            "/sp/campaigns/list",
            "application/vnd.spCampaign.v3+json",
            "token-1",
        )

        self.assertEqual(payload["nextToken"], "next")
        self.assertEqual(client.authenticated_request.call_count, 2)
        self.assertEqual(
            client.authenticated_request.call_args.kwargs["json"]["nextToken"],
            "token-1",
        )
        sleep.assert_called_once()

    @patch(
        "dpp_analytics.amazon_ads_entities.settings",
        SimpleNamespace(
            ads_enabled=True,
            ads_credentials_present=True,
            marketplace_id="A1AM78C64UM0Y8",
        ),
    )
    @patch("dpp_analytics.amazon_ads_entities._save_page", return_value=1)
    @patch("dpp_analytics.amazon_ads_entities._request_page")
    @patch("dpp_analytics.amazon_ads_entities._finish_batch")
    @patch("dpp_analytics.amazon_ads_entities._begin_batch")
    @patch("dpp_analytics.amazon_ads_entities.db.ingestion_run", side_effect=_run_context)
    @patch(
        "dpp_analytics.amazon_ads_entities.discover_scopes",
        return_value=(["profile-1"], {"source": "configured"}),
    )
    def test_complete_snapshot_is_published_only_after_every_entity_type(
        self,
        _discover,
        _ingestion_run,
        begin_batch,
        finish_batch,
        request_page,
        save_page,
    ) -> None:
        request_page.return_value = {}
        client = MagicMock()

        result = ingest_ads_entities(client)

        self.assertEqual(result["records_written"], len(ENTITY_CONFIGS))
        self.assertEqual(request_page.call_count, len(ENTITY_CONFIGS))
        self.assertEqual(save_page.call_count, len(ENTITY_CONFIGS))
        begin_batch.assert_called_once()
        finish_batch.assert_called_once()
        self.assertEqual(finish_batch.call_args.kwargs["status"], "COMPLETE")
        self.assertEqual(
            finish_batch.call_args.kwargs["counts"],
            {entity_type: 1 for entity_type, *_rest in ENTITY_CONFIGS},
        )

    @patch(
        "dpp_analytics.amazon_ads_entities.settings",
        SimpleNamespace(
            ads_enabled=True,
            ads_credentials_present=True,
            marketplace_id="A1AM78C64UM0Y8",
        ),
    )
    @patch("dpp_analytics.amazon_ads_entities._request_page", side_effect=RuntimeError("blocked"))
    @patch("dpp_analytics.amazon_ads_entities._finish_batch")
    @patch("dpp_analytics.amazon_ads_entities._begin_batch")
    @patch("dpp_analytics.amazon_ads_entities.db.ingestion_run", side_effect=_run_context)
    @patch(
        "dpp_analytics.amazon_ads_entities.discover_scopes",
        return_value=(["profile-1"], {"source": "configured"}),
    )
    def test_failed_snapshot_cannot_replace_last_complete_batch(
        self,
        _discover,
        _ingestion_run,
        _begin_batch,
        finish_batch,
        _request_page,
    ) -> None:
        with self.assertRaisesRegex(RuntimeError, "blocked"):
            ingest_ads_entities(MagicMock())

        self.assertEqual(finish_batch.call_args.kwargs["status"], "FAILED")
        self.assertIn("RuntimeError: blocked", finish_batch.call_args.kwargs["error"])


if __name__ == "__main__":
    unittest.main()
