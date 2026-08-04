# Allowed breaking changes — internal/schemas/bucket.yml

One line per accepted finding: the endpoint plus the finding's description,
backticks included (format details in `../README.md`). Remove entries after
the PR merges — a stale entry masks future accidental breaks.

A break here means already-stored bucket objects stop parsing or readers lose
required fields — allowlist one only with a migration or upgrade seam in place
(see development_docs/migrations.md).

GET /projects/{pid}/secrets/{name}.json `api path removed without deprecation`
PUT /projects/{pid}/secrets/{name}.json `api path removed without deprecation`

Event objects written by `EventService` already contain `id`; making it required
records the existing write contract and needs no stored-data migration.

```text
PUT /_system/events/{date}/{id}.json `added the new required request property `id``
```
