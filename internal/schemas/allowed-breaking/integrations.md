# Allowed breaking changes — internal/schemas/integrations.yml

One line per accepted finding: the endpoint plus the finding's description,
backticks included (format details in `../README.md`). Remove entries after
the PR merges — a stale entry masks future accidental breaks.

A break here means stored integration configs stop validating, or a secret
path moved — the latter always needs a decrypt-and-reseal migration (bump the
kind's `schemaVersion` and add a `migrate` step).

Anonymous S3 authentication adds a response variant. Existing configurations
and response variants do not change.

```text
GET /kinds/s3/config added `subschema #3` to the `auth` response property `oneOf` list for the response status `200`
```
