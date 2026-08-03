# Allowed breaking changes — internal/schemas/integrations.yml

One line per accepted finding: the endpoint plus the finding's description,
backticks included (format details in `../README.md`). Remove entries after
the PR merges — a stale entry masks future accidental breaks.

A break here means stored integration configs stop validating, or a secret
path moved — the latter always needs a decrypt-and-reseal migration (bump the
kind's `schemaVersion` and add a `migrate` step).

## Tightened http(s) URL validation (PR #66)

The shared endpoint pattern now requires a non-empty authority and a port in
range. It previously accepted `https:///api`, which WHATWG URL parsing resolves
to the host `api` — so a typo silently pointed a catalog URI, and the bearer
token sent with it, at a different server.

It stops accepting exactly three shapes, none of which could have worked: an
empty authority, a port that is not a number in 1–65535 (`new URL` throws on
`:65536`), and a bracketed host holding anything but hex digits, colons, and
dots — an IPv6 zone id. Whitespace was already rejected by the previous `\S+`.

The `oneOf` findings are an artifact of the same change. Three Iceberg storage
branches carry a URL field, so oasdiff cannot pair them across the change and
reports each as removed and re-added.

- GET /kinds/iceberg_bigquery/config — added `subschema #2, subschema #3, subschema #6` to the `storage` response property `oneOf` list for the response status `200`
- PUT /kinds/iceberg_bigquery/config — removed `subschema #2, subschema #3, subschema #6` from the `storage` request property `oneOf` list
- GET /kinds/iceberg_dynamodb/config — added `subschema #2, subschema #3, subschema #6` to the `storage` response property `oneOf` list for the response status `200`
- PUT /kinds/iceberg_dynamodb/config — removed `subschema #2, subschema #3, subschema #6` from the `storage` request property `oneOf` list
- GET /kinds/iceberg_glue/config — added `subschema #2, subschema #3, subschema #6` to the `storage` response property `oneOf` list for the response status `200`
- PUT /kinds/iceberg_glue/config — removed `subschema #2, subschema #3, subschema #6` from the `storage` request property `oneOf` list
- GET /kinds/iceberg_hive/config — added `subschema #2, subschema #3, subschema #6` to the `storage` response property `oneOf` list for the response status `200`
- PUT /kinds/iceberg_hive/config — removed `subschema #2, subschema #3, subschema #6` from the `storage` request property `oneOf` list
- GET /kinds/iceberg_rest/config — added `subschema #2, subschema #3, subschema #6` to the `storage` response property `oneOf` list for the response status `200`
- PUT /kinds/iceberg_rest/config — removed `subschema #2, subschema #3, subschema #6` from the `storage` request property `oneOf` list
- GET /kinds/iceberg_sql/config — added `subschema #2, subschema #3, subschema #6` to the `storage` response property `oneOf` list for the response status `200`
- PUT /kinds/iceberg_sql/config — removed `subschema #2, subschema #3, subschema #6` from the `storage` request property `oneOf` list
