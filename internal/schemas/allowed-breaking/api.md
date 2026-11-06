# Allowed breaking changes — packages/api/openapi.yaml

One line per accepted finding: the endpoint plus the finding's description,
backticks included (format details in `../README.md`). Remove entries after
the PR merges — a stale entry masks future accidental breaks.

Pre-release pass over the unreleased v0.6.2 surface (notebook moves). Remove after merge.

```text
POST /api/v1/projects/{pid}/notebooks/{nid}/move added the pattern `^proj-[0-9a-z]{16}$` to the request property `destination_project_id`
```
