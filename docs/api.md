---
description: Use the authenticated JSON API, published OpenAPI document, and typed TypeScript client.
---

# API & client

marimohub exposes a JSON HTTP API under `/api/v1/*` and ships a typed TypeScript
client generated from its OpenAPI document.

## Response envelope

JSON responses under `/api/v1/*` use one envelope:

```jsonc
// success
{ "success": true, "data": { /* … */ } }
// failure
{ "success": false, "error": { "code": "FORBIDDEN", "message": "…" } }
```

The HTML snapshot route returns raw `text/html` on success. Its errors still
use the JSON envelope.

Authentication is via the session cookie issued by your [auth](/auth) backend,
or a [personal access token](/api-tokens) sent as `Authorization: Bearer …`
(for CI, scripts, and the CLI).
Project reads require effective `viewer` access through ownership, membership,
or `MARIMOHUB_DEFAULT_ROLE`; `none` hides non-member projects. Writes are
role-gated, and the audit log requires project `admin` (see
[Security → Authorization](/security#authorization-roles)).
Editor ownership, temporary session creation, and takeover are documented in
[Editor sessions](/editor-sessions).

## Endpoints

The docs site publishes the OpenAPI 3.1 document at
**[`/openapi.yaml`](/openapi.yaml)** from the same source checkout used to build
these docs. Use that URL for code generation and offline tooling.

A running hub also serves **`GET /api/v1/doc`**. That endpoint is protected like
the rest of `/api/v1/*`, so send a session cookie or PAT:

```bash
export MARIMOHUB_URL=https://hub.example.com
export MARIMOHUB_TOKEN=mhub_pat_…
curl --fail --location \
  --header "Authorization: Bearer ${MARIMOHUB_TOKEN}" \
  "${MARIMOHUB_URL}/api/v1/doc" \
  --output openapi.yaml
```

The repository source is
[`packages/api/openapi.yaml`](https://github.com/marimo-team/marimohub/blob/main/packages/api/openapi.yaml).

Resource groups:

- **Projects** — list/create/update/delete projects; add/update/remove members
  (`/projects/{pid}/members`). Project responses carry `your_role` (the caller's
  effective role). Admins can read the audit log one UTC day at a time
  (`GET /projects/{pid}/events?date=YYYY-MM-DD`, defaults to today) — every
  project/notebook mutation is recorded as an event.
- **Notebooks** — create and manage local or Git-synced notebooks, read code,
  manage versions, and rotate notebook sync tokens.
- **Sessions** — list, create, inspect, heartbeat, and stop kernel sessions.
  The session routes also expose editor ownership and exclusive takeover.
- **Integrations** — discover integration kinds and manage project or
  organization integration instances. Version-history lists use pagination.
- **Secrets** — list secret metadata, store or delete project secrets, and test
  secret references without returning secret values.
- **Users and tokens** — resolve or search users, and create, list, or revoke
  personal access tokens.
- **System** — `GET /api/v1/version` and `GET /api/v1/capabilities` report
  deployment information. `GET /api/health` is the unversioned health probe.

## Pagination

The project, notebook, notebook-version, project-session, integration-instance,
and integration-version list endpoints return this page shape:

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

Pass `?limit=` to set the page size. Pass a prior `next_cursor` as `?cursor=` to
get the next page. Items are ordered newest-first. A `next_cursor` value of
`null` marks the final page. The cursor is opaque.

Some small or naturally bounded collections still return arrays. These include
project members, secrets, API tokens, integration kinds, audit events, and user
search results. The OpenAPI response schema is authoritative for each route.
`GET /api/v1/capabilities` reports the default and maximum page sizes and other
server limits.

## Caching

Every read (`GET`) carries a weak `ETag` and `Cache-Control: no-cache`. Send the
ETag back as `If-None-Match` to revalidate; an unchanged resource answers `304
Not Modified` with no body. Browsers do this automatically, which keeps the
session-status poll loop cheap.

## Typed client

[`@marimo-hub/client`](https://github.com/marimo-team/marimohub/tree/main/packages/client)
uses the same generated OpenAPI document, so paths, parameters, bodies, and
responses are checked against the live routes. `apiData` unwraps the envelope
and throws an `ApiRequestError` on failure.

```ts
import { apiData, createApiClient } from '@marimo-hub/client';

const api = createApiClient({
	baseUrl: 'https://hub.example.com',
	headers: { Authorization: `Bearer ${process.env.MARIMOHUB_TOKEN}` },
});
const user = await apiData(api.GET('/api/v1/me'));
```

The exported types (`Project`, `NotebookMeta`, `NotebookDetail`, `Session`,
`Version`, `ResolvedUser`, plus the full `paths` / `components` / `operations`)
come straight from the schema. The marimohub SPA itself consumes this client.
