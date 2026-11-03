# Allowed breaking changes — packages/api/openapi.yaml

One line per accepted finding: the endpoint plus the finding's description,
backticks included (format details in `../README.md`). Remove entries after
the PR merges — a stale entry masks future accidental breaks.

Pre-release pass over the unreleased v0.5.4 surface (support reports, manual MCP
tokens, search). None of these routes or fields shipped in a tagged release.

```text
GET /api/v1/capabilities removed the required property `data/support/mode` from the response with the `200` status
POST /api/v1/me/tokens/mcp the request property `expires_in_days` became required
POST /api/v1/me/tokens/mcp the `expires_in_days` request property's max was decreased to `90.00`
GET /api/v1/search removed the required property `data/items/items/score` from the response with the `200` status
```
