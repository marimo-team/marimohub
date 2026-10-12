# Allowed breaking changes — packages/api/openapi.yaml

One line per accepted finding: the endpoint plus the finding's description,
backticks included (format details in `../README.md`). Remove entries after
the PR merges — a stale entry masks future accidental breaks.

Project alert kinds gained `project.default_access_changed`. The destination
schemas embed the kind vocabulary, so oasdiff reports their `oneOf` branches as
replaced. Existing destination payloads remain valid.

```text
GET /api/v1/projects/{pid}/alert-destinations added `subschema #1, subschema #2` to the `data/items/items/` response property `oneOf` list for the response status `200`
POST /api/v1/projects/{pid}/alert-destinations removed `subschema #1, subschema #2` from the request body `oneOf` list
POST /api/v1/projects/{pid}/alert-destinations added `subschema #1, subschema #2` to the `data` response property `oneOf` list for the response status `201`
PATCH /api/v1/projects/{pid}/alert-destinations/{aid} removed `subschema #1, subschema #2` from the request body `oneOf` list
PATCH /api/v1/projects/{pid}/alert-destinations/{aid} added `subschema #1, subschema #2` to the `data` response property `oneOf` list for the response status `200`
POST /api/v1/projects/{pid}/alert-destinations/{aid}/test added `subschema #1, subschema #2` to the `data` response property `oneOf` list for the response status `200`
```

Tags are bounded (1–256 characters each, at most 50 per resource) so list rows
and namespace filters stay small. Empty tags were never meaningful.

```text
POST /api/v1/projects the `tags/items/` request property's minLength was increased from `0` to `1`
PATCH /api/v1/projects/{pid} the `tags/items/` request property's minLength was increased from `0` to `1`
POST /api/v1/projects/{pid}/notebooks the `tags/items/` request property's minLength was increased from `0` to `1`
POST /api/v1/projects/{pid}/notebooks/git the `tags/items/` request property's minLength was increased from `0` to `1`
PATCH /api/v1/projects/{pid}/notebooks/{nid} the `tags/items/` request property's minLength was increased from `0` to `1`
```

`app_compute_profile` shipped unreleased in #499. Create requests never clear an
override, so the field no longer accepts `null` there; the update body still does.

```text
POST /api/v1/projects/{pid}/notebooks the request property `app_compute_profile` became not nullable
POST /api/v1/projects/{pid}/notebooks/git the request property `app_compute_profile` became not nullable
```
