# Allowed breaking changes — packages/api/openapi.yaml

One line per accepted finding: the endpoint plus the finding's description,
backticks included (format details in `../README.md`). Remove entries after
the PR merges — a stale entry masks future accidental breaks.

GET /api/v1/projects/{pid}/secrets api path removed without deprecation
POST /api/v1/projects/{pid}/secrets/validate api path removed without deprecation
DELETE /api/v1/projects/{pid}/secrets/{name} api path removed without deprecation
PUT /api/v1/projects/{pid}/secrets/{name} api path removed without deprecation
