# Allowed breaking changes — internal/schemas/integrations.yml

One line per accepted finding: the endpoint plus the finding's description,
backticks included (format details in `../README.md`). Remove entries after
the PR merges — a stale entry masks future accidental breaks.

A break here means stored integration configs stop validating, or a secret
path moved — the latter always needs a decrypt-and-reseal migration (bump the
kind's `schemaVersion` and add a `migrate` step).

Pre-release pass over the unreleased `logger_names` field of `otlp_logs` (#622): names are
now bounded and must be dotted logger names. Remove after merge.

```text
PUT /kinds/otlp_logs/config added the pattern `^[^.\s]+(?:\.[^.\s]+)*$` to the request property `logger_names/items/name`
PUT /kinds/otlp_logs/config the `logger_names/items/name` request property's maxLength was set to `256`
```
