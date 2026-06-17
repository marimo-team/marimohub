# API & client

MarimoHub exposes a JSON HTTP API under `/api/v1/*` and ships a typed TypeScript
client generated from its OpenAPI document.

## Response envelope

Every `/api/v1/*` response uses one envelope:

```jsonc
// success
{ "success": true, "data": { /* … */ } }
// failure
{ "success": false, "error": { "code": "FORBIDDEN", "message": "…" } }
```

Authentication is via the session cookie issued by your [auth](/auth) backend.
Reads are open to any authenticated user; writes are role-gated (see
[Security → Authorization](/security#authorization-roles)). The one read
exception is the audit log, which requires project `admin`.

## Endpoints

The OpenAPI 3.1 document is served live at **`GET /api/v1/doc`** (and the source is
[`packages/api/openapi.yaml`](https://github.com/marimo-team/marimohub/blob/main/packages/api/openapi.yaml)).
Point any OpenAPI tool (Swagger UI, Scalar, code generators) at it.

Resource groups:

- **Projects** — list/create/update/delete projects; add/update/remove members
  (`/projects/{pid}/members`). Project responses carry `your_role` (the caller's
  effective role). Admins can read the audit log one UTC day at a time
  (`GET /projects/{pid}/events?date=YYYY-MM-DD`, defaults to today) — every
  project/notebook mutation is recorded as an event.
- **Notebooks** — CRUD notebooks, read code, list/get/restore versions, export
  `workspace.zip`.
- **Sessions** — start/stop kernel sessions.
- **Users** — resolve member identities.
- **Meta** — `GET /api/v1/version` (deploy info) and `GET /api/health` (probe).

## Pagination

List endpoints return a page rather than a bare array:

```jsonc
{
	"success": true,
	"data": {
		"items": [
			/* … */
		],
		"next_cursor": "MTAw",
	},
}
```

Pass `?limit=` to bound the page size and `?cursor=` (echoing a prior
`next_cursor`) to fetch the next page. Items are ordered newest-first. A
`next_cursor` of `null` means there are no more pages. The cursor is opaque —
treat it as a token, not a parsable value. Server-enforced limits (default/max
page size, max request bytes, session cap, version retention) are reported by
`GET /api/v1/capabilities`.

## Caching

Every read (`GET`) carries a weak `ETag` and `Cache-Control: no-cache`. Send the
ETag back as `If-None-Match` to revalidate; an unchanged resource answers `304
Not Modified` with no body. Browsers do this automatically, which keeps the
session-status poll loop cheap.

## Typed client

[`@marimo-hub/client`](https://github.com/marimo-team/marimohub/tree/main/packages/client)
is generated from the same OpenAPI document, so its types always match the live
routes. It unwraps the envelope and throws a typed `ApiRequestError` on failure.

```ts
import { apiFetch, type Project } from '@marimo-hub/client';

// GET /api/v1/projects/{id} → unwrapped data, fully typed
const project = await apiFetch<Project>(`/api/v1/projects/${id}`);
```

The exported types (`Project`, `NotebookMeta`, `NotebookDetail`, `Session`,
`Version`, `ResolvedUser`, plus the full `paths` / `components` / `operations`)
come straight from the schema. The MarimoHub SPA itself consumes this client.
