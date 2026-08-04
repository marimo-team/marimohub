# Allowed breaking changes — packages/api/openapi.yaml

One line per accepted finding: the endpoint plus the finding's description,
backticks included (format details in `../README.md`). Remove entries after
the PR merges — a stale entry masks future accidental breaks.

GET /api/v1/projects/{pid}/secrets `api path removed without deprecation`
POST /api/v1/projects/{pid}/secrets/validate `api path removed without deprecation`
DELETE /api/v1/projects/{pid}/secrets/{name} `api path removed without deprecation`
PUT /api/v1/projects/{pid}/secrets/{name} `api path removed without deprecation`

GET /api/v1/version removed the required property `data/backends` from the response with the `200` status
GET /api/v1/version removed the required property `data/image` from the response with the `200` status
GET /api/v1/version removed the required property `data/node` from the response with the `200` status
GET /api/v1/version removed the required property `data/replica` from the response with the `200` status
GET /api/v1/version removed the required property `data/sandbox_image` from the response with the `200` status
GET /api/v1/version removed the required property `data/started_at` from the response with the `200` status
