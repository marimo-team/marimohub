# Allowed breaking changes — packages/api/openapi.yaml

One line per accepted finding: the endpoint plus the finding's description,
backticks included (format details in `../README.md`). Remove entries after
the PR merges — a stale entry masks future accidental breaks.

Pre-release pass over the unreleased v0.6.2 surface (notebook moves). Remove after merge.

```text
POST /api/v1/projects/{pid}/notebooks/{nid}/move added the pattern `^proj-[0-9a-z]{16}$` to the request property `destination_project_id`
```

PR-managed previews can live until closure without a timestamp. Existing manual
previews keep their finite expiry. The updated client handles `null`; upgrade
Hub replicas and clients before enabling the Action.

```text
GET /api/v1/projects/{pid}/notebooks/{nid}/previews the response property `data/items/items/expires_at` became nullable for the status `200`
POST /api/v1/projects/{pid}/notebooks/{nid}/previews the response property `data/expires_at` became nullable for the status `202`
GET /api/v1/projects/{pid}/notebooks/{nid}/previews/{prid} the response property `data/expires_at` became nullable for the status `200`
```
