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

`aws_codeartifact` shipped unreleased after v0.4.16. The `token` auth method and
`duration_seconds` were removed and `federation` was renamed to `ambient` before release.

```text
GET /kinds/aws_codeartifact/config added `subschema #1, subschema #2` to the `auth` response property `oneOf` list for the response status `200`
GET /kinds/aws_codeartifact/config removed the required property `duration_seconds` from the response with the `200` status
PUT /kinds/aws_codeartifact/config removed `subschema #1, subschema #2, subschema #3` from the `auth` request property `oneOf` list
PUT /kinds/aws_codeartifact/config removed the request property `duration_seconds`
```
