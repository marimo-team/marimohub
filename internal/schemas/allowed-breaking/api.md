# Allowed breaking changes — packages/api/openapi.yaml

One line per accepted finding: the endpoint plus the finding's description,
backticks included (format details in `../README.md`). Remove entries after
the PR merges — a stale entry masks future accidental breaks.

Pre-release pass over the unreleased working-branch routes: they move under a
`working-branch` namespace. Remove after merge.

```text
POST /api/v1/projects/{pid}/notebooks/{nid}/change-requests api path removed without deprecation
GET /api/v1/projects/{pid}/notebooks/{nid}/saves/{save_id} api path removed without deprecation
GET /api/v1/projects/{pid}/notebooks/{nid}/saves/{save_id}/recovery api path removed without deprecation
POST /api/v1/projects/{pid}/notebooks/{nid}/saves/{save_id}/retry api path removed without deprecation
POST /api/v1/projects/{pid}/notebooks/{nid}/sessions/{sid}/saves api path removed without deprecation
```

Working-branch response enums become extensible (`unknown` fallback) before release.

```text
GET /api/v1/projects/{pid}/notebooks/{nid}/working-branch added the new `unknown` enum value to the `data/change_request/state` response property for the response status `200`
GET /api/v1/projects/{pid}/notebooks/{nid}/working-branch added the new `unknown` enum value to the `data/ended_reason` response property for the response status `200`
```
