# Allowed breaking changes — internal/schemas/bucket.yml

One line per accepted finding: the endpoint plus the finding's description,
backticks included (format details in `../README.md`). Remove entries after
the PR merges — a stale entry masks future accidental breaks.

A break here means already-stored bucket objects stop parsing or readers lose
required fields — allowlist one only with a migration or upgrade seam in place
(see development_docs/migrations.md).

The reserved `chat` search kind never had a source, so no stored page or snapshot
contains it; removing it before the first search release needs no migration.

```text
PUT /_system/search/projects/{pid}/{source}/pages/{page}.json removed the enum value `chat` of the request property `documents/items/kind`
PUT /_system/search/projects/{pid}/{source}/pages/{page}.json removed `subschema #3` from the `documents/items/resource` request property `oneOf` list
PUT /_system/search/projects/{pid}/{source}/snapshots/{generation}.json removed the enum value `chat` of the request property `documents/items/kind`
PUT /_system/search/projects/{pid}/{source}/snapshots/{generation}.json removed `subschema #3` from the `documents/items/resource` request property `oneOf` list
```
