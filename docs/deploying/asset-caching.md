---
description: Share marimo assets across sessions and configure response compression.
---

# Asset caching and compression

Each sandbox has a different origin or session path. A shared asset origin lets
browsers reuse marimo's frontend across sessions and projects. See
[Shared marimo assets](../marimo-assets.md) for the `MARIMOHUB_COMPUTE_ASSET_URL`
values, staging, and verification.

## Hub responses

The Node server applies all of these rules. The Cloudflare Worker applies only the
API revalidation rules.

### Compression

The Node server compresses eligible `/api/*` and proxied kernel responses with
gzip or deflate. It does not compress these responses:

- Bodies with a declared length below 1 KiB.
- Event streams, `HEAD` responses, and range responses.
- Responses that already have `Content-Encoding` or `Transfer-Encoding`.
- Responses with `Cache-Control: no-transform`.

The server compresses unknown-length responses without a size probe. WebSocket
upgrades bypass compression. Compressed and `304` responses carry
`Vary: Accept-Encoding`. Compression changes a strong `ETag` to a weak `ETag`.

### Static files

The frontend build adds Brotli and gzip files when they are smaller than the
original. The static server selects these files and adds `Vary: Accept-Encoding`.
Fingerprinted files under `/assets/` get
`Cache-Control: public, max-age=31536000, immutable`. The HTML shell and other
files get `Cache-Control: public, max-age=0, must-revalidate`.

The HTML shell stays uncompressed, because the server inserts the base URL at
request time. The server also inserts a script that prefetches API data. It
removes the shell's `fetch` preload tags, because the script would request each
URL a second time. The Cloudflare Worker and static hosts keep the preload tags.

### Hub-served marimo assets

Hashed files under `/_marimo/{version}/` get
`Cache-Control: public, max-age=31536000, immutable`. Unhashed files revalidate.
Errors get `Cache-Control: no-store`. Files from the static root carry
`Vary: Accept-Encoding`, `Access-Control-Allow-Origin: *`,
`Cross-Origin-Resource-Policy: cross-origin`, and `X-Content-Type-Options: nosniff`.

### API revalidation

A successful `/api/v1` `GET` gets `Cache-Control: private, no-cache`, unless the
route sets its own policy. A JSON `GET` or `HEAD` response with a declared length
of 256 KiB or less gets a weak `ETag`, unless the route sets one. A matching
`If-None-Match` request returns `304 Not Modified` with cache metadata and no body.
`Cache-Control: no-store` disables the `ETag` and revalidation. The generated
`ETag` hashes the uncompressed body, so it stays the same across encodings.

### Verify through the ingress

Before rollout, check these behaviors through the deployed ingress:

- API JSON larger than 1 KiB returns gzip when requested and decodes once.
- Chat, host-protocol, and kernel event streams deliver events without buffering.
- The upstream compressor skips responses with `Content-Encoding`.

See [CKS kernel compression](./cks.md#kernel-response-compression) for Traefik configuration.

## Connection capacity

`MARIMOHUB_STORAGE_S3_MAX_SOCKETS` sets the S3 connection limit per origin for
HTTP and HTTPS. It accepts positive safe integers. The default is 256.
GCS and Azure have no equivalent per-client setting.
See [Kubernetes capacity](./kubernetes.md#hub-resource-capacity) for hub resource limits.
