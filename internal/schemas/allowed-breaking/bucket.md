# Allowed breaking changes — internal/schemas/bucket.yml

One line per accepted finding: the endpoint plus the finding's description,
backticks included (format details in `../README.md`). Remove entries after
the PR merges — a stale entry masks future accidental breaks.

A break here means already-stored bucket objects stop parsing or readers lose
required fields — allowlist one only with a migration or upgrade seam in place
(see development_docs/migrations.md).

Pre-release pass over the unreleased v0.6.2 records (notebook moves, host retries, search refresh). Remove after merge.

```text
PUT /_system/host-retries/{digest}.json removed `subschema #1, subschema #2` from the request body `anyOf` list
GET /_system/search/refresh/{pid}.json api path removed without deprecation
PUT /_system/search/refresh/{pid}.json api path removed without deprecation
PUT /_system/notebook-moves/{nid}.json the request property `snapshots` became required
```

PR-managed previews add unbounded lifetimes. Existing records keep their finite
expiry and still parse without migration. Upgrade all Hub replicas before
enabling the Action; older replicas cannot read new records with null expiry.

```text
GET /_system/preview-projects/{pid}.json response property `entries/items/intent/expires_at` list-of-types was widened by adding types `null` to media type `application/json` of response `200`
GET /_system/previews/{pid}/{nid}/{preview_id}.json response property `expires_at` list-of-types was widened by adding types `null` to media type `application/json` of response `200`
```
