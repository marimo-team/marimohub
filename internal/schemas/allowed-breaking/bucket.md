# Allowed breaking changes — internal/schemas/bucket.yml

One line per accepted finding: the endpoint plus the finding's description,
backticks included (format details in `../README.md`). Remove entries after
the PR merges — a stale entry masks future accidental breaks.

A break here means already-stored bucket objects stop parsing or readers lose
required fields — allowlist one only with a migration or upgrade seam in place
(see development_docs/migrations.md).

Pre-release pass over the unreleased session startup status (#718): the stored startup `phase`
and `observed` values become open strings so records written by a newer replica during a rolling
deploy still parse; readers normalize to the known phases. Widening, not narrowing: every stored
value remains valid. Remove after merge.

```text
PUT /_system/sessions/{pid}/{sid}.json removed the enum value `allocating` of the request property `startup/observed/items/`
PUT /_system/sessions/{pid}/{sid}.json removed the enum value `allocating` of the request property `startup/phase`
PUT /_system/sessions/{pid}/{sid}.json removed the enum value `allocating` of the request property `startup_completion/startup/observed/items/`
PUT /_system/sessions/{pid}/{sid}.json removed the enum value `allocating` of the request property `startup_completion/startup/phase`
PUT /_system/sessions/{pid}/{sid}.json removed the enum value `starting` of the request property `startup/observed/items/`
PUT /_system/sessions/{pid}/{sid}.json removed the enum value `starting` of the request property `startup/phase`
PUT /_system/sessions/{pid}/{sid}.json removed the enum value `starting` of the request property `startup_completion/startup/observed/items/`
PUT /_system/sessions/{pid}/{sid}.json removed the enum value `starting` of the request property `startup_completion/startup/phase`
PUT /_system/sessions/{pid}/{sid}.json removed the enum value `workspace` of the request property `startup/observed/items/`
PUT /_system/sessions/{pid}/{sid}.json removed the enum value `workspace` of the request property `startup/phase`
PUT /_system/sessions/{pid}/{sid}.json removed the enum value `workspace` of the request property `startup_completion/startup/observed/items/`
PUT /_system/sessions/{pid}/{sid}.json removed the enum value `workspace` of the request property `startup_completion/startup/phase`
PUT /_system/sessions/{pid}/{sid}.json the `startup/observed/items/` request property's minLength was increased from `0` to `1`
PUT /_system/sessions/{pid}/{sid}.json the `startup/phase` request property's minLength was increased from `0` to `1`
PUT /_system/sessions/{pid}/{sid}.json the `startup_completion/startup/observed/items/` request property's minLength was increased from `0` to `1`
PUT /_system/sessions/{pid}/{sid}.json the `startup_completion/startup/phase` request property's minLength was increased from `0` to `1`
```
