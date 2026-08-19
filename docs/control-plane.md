# Control plane

The repository is both source of truth and deployment control plane for the self-hosted DPP Analytics host.

## Feedback channel

The production workflow updates a dedicated GitHub issue after every deployment attempt. That issue is the machine-readable operational heartbeat used to inspect host state without SSH access.

It reports:

- workflow outcome
- hostname and timestamp
- Docker/Compose versions
- container state
- PostgreSQL health
- Grafana health
- disk and memory summary
- latest deployed commit

Do not place credentials, tokens, environment files, or other secrets in the heartbeat.
