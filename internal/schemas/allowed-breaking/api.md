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

GET /api/v1/projects/{pid}/notebooks/{nid} the response property `data/source/oneOf[subschema #2]/provider` became nullable for the status `200`
PATCH /api/v1/projects/{pid}/notebooks/{nid}/source the response property `data/source/provider` became nullable for the status `200`

GET /api/v1/projects/{pid}/alert-destinations the `data` response's property `type` changed from `array<any>` to `object` for status `200`
POST /api/v1/projects/{pid}/alert-destinations added `subschema #1, subschema #2` to the `data` response property `oneOf` list for the response status `201`
PATCH /api/v1/projects/{pid}/alert-destinations/{aid} added `subschema #1, subschema #2` to the `data` response property `oneOf` list for the response status `200`
POST /api/v1/projects/{pid}/alert-destinations/{aid}/test added `subschema #1, subschema #2` to the `data` response property `oneOf` list for the response status `200`
GET /api/v1/projects/{pid}/integrations/{iid}/browse removed the required property `data/metadata` from the response with the `200` status
GET /api/v1/projects/{pid}/integrations/{iid}/browse removed the required property `data/preview` from the response with the `200` status
GET /api/v1/projects/{pid}/integrations/{iid}/browse removed the optional property `data/reason` from the response with the `200` status
POST /api/v1/projects/{pid}/integrations/{iid}/browse/objects/preview added `subschema #1, subschema #2, subschema #3` to the `data` response property `oneOf` list for the response status `200`
