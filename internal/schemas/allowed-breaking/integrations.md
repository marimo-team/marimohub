# Allowed breaking changes — internal/schemas/integrations.yml

One line per accepted finding: the endpoint plus the finding's description,
backticks included (format details in `../README.md`). Remove entries after
the PR merges — a stale entry masks future accidental breaks.

A break here means stored integration configs stop validating, or a secret
path moved — the latter always needs a decrypt-and-reseal migration (bump the
kind's `schemaVersion` and add a `migrate` step).

Pre-release pass over the unreleased v0.6.2 logging kinds (#607): the vendor kinds
became `otlp_logs` auth recipes and `headers` moved under `auth`. Remove after merge.

```text
GET /kinds/better_stack_logs/config api path removed without deprecation
PUT /kinds/better_stack_logs/config api path removed without deprecation
GET /kinds/grafana_cloud_logs/config api path removed without deprecation
PUT /kinds/grafana_cloud_logs/config api path removed without deprecation
GET /kinds/otlp_logs/config removed the required property `headers` from the response with the `200` status
```
