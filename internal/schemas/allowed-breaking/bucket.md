# Allowed breaking changes — internal/schemas/bucket.yml

One line per accepted finding: the endpoint plus the finding's description,
backticks included (format details in `../README.md`). Remove entries after
the PR merges — a stale entry masks future accidental breaks.

A break here means already-stored bucket objects stop parsing or readers lose
required fields — allowlist one only with a migration or upgrade seam in place
(see development_docs/migrations.md).

Pre-release pass over the unreleased working-branch head record (#665): the stored
change-request fields move to snake_case before any release writes them. Remove after merge.

```text
GET /_system/working-branches/notebooks/{pid}/{nid}/head.json removed the required property `change_request/baseBranch` from the response with the `200` status
GET /_system/working-branches/notebooks/{pid}/{nid}/head.json removed the required property `change_request/headBranch` from the response with the `200` status
PUT /_system/working-branches/notebooks/{pid}/{nid}/head.json added the new required request property `change_request/base_branch`
PUT /_system/working-branches/notebooks/{pid}/{nid}/head.json added the new required request property `change_request/head_branch`
PUT /_system/working-branches/notebooks/{pid}/{nid}/head.json removed the request property `change_request/baseBranch`
PUT /_system/working-branches/notebooks/{pid}/{nid}/head.json removed the request property `change_request/headBranch`
```
