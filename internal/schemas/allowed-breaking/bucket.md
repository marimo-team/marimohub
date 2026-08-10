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

`provider` widened from const `github` to a nullable github/gitlab enum. Pure
widening: every stored source (`provider: "github"`) still parses, and readers
already treat the field as a display hint. No migration needed.

```text
GET /projects/{pid}/notebooks/{nid}/source.json the `provider` response property const value `github` was removed for the status `200`
GET /projects/{pid}/notebooks/{nid}/source.json response property `oneOf[subschema #2]/provider` list-of-types was widened by adding types `null` to media type `application/json` of response `200`
```
