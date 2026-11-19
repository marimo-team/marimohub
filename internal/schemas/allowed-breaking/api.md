# Allowed breaking changes — packages/api/openapi.yaml

One line per accepted finding: the endpoint plus the finding's description,
backticks included (format details in `../README.md`). Remove entries after
the PR merges — a stale entry masks future accidental breaks.

Pre-release pass over the unreleased session startup stream (#699): the `text/event-stream`
response content gains a typed `SessionStartupEvent` schema in place of a plain string. Remove after merge.

```text
POST /api/v1/projects/{pid}/notebooks/{nid}/sessions added `subschema #1, subschema #2, subschema #3` to the response body `oneOf` list for the response status `200`
```
