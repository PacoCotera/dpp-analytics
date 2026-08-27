# DPP Analytics repository instructions

## Start here

Before changing the application:

1. Read `docs/README.md` and `docs/maintenance.md`.
2. Read the relevant data, metric, cache, frontend, or control-plane document for the affected domain.
3. For the 2026-08-27 audit backlog, read `docs/audits/dpp-analytics-2026-08-27.md` and master tracker #161.
4. Reconcile the selected audit ID with its current GitHub issue state. The issue is authoritative for execution status; the audit is authoritative for the original evidence and acceptance criteria.

## Audit backlog workflow

- Start with the highest-priority Ready issue unless the user names another issue.
- Work one P1 at a time. Do not silently broaden its scope or combine unrelated data-contract changes.
- Reproduce the finding against the current deployed production SHA before editing.
- Treat production data and APIs as evidence. Do not invent business meaning, thresholds, lifecycle mappings, or accounting interpretations.
- Fix business truth in its canonical warehouse/API owner. Do not hide a data defect with a browser-only correction.
- Preserve the ownership and architecture contracts in `docs/maintenance.md`.
- Add automated coverage for the issue acceptance criteria and relevant edge cases.
- Use a pull request that references the issue.
- After deployment, verify the exact production SHA with DPP Playwright.
- Close the issue only after posting the repeatable production evidence. Update master tracker #161 at the same time.

## Product standard

DPP Analytics must be easy to use, fast, and accurate across the main business domains. Interpretive labels must be factually based, repeatable, and traceable to explicit inputs, windows, thresholds, and eligibility rules.

## Existing durable context

- #11: product backlog and product-quality contract.
- #22: Ads authorization and disconnected-state backlog.
- #38: frontend architecture program.
- #44 and #62: Finance and production-number diagnostics.
- #122: performance history.
