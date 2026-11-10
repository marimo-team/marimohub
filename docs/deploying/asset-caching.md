---
description: Share marimo assets across sessions and configure response compression.
---

# Asset caching and compression

Each sandbox has a different origin or session path. A shared asset URL lets
browsers reuse marimo's frontend across sessions and projects.

## Shared marimo assets

`MARIMOHUB_COMPUTE_ASSET_URL` defaults to `hub`, marimo's special key for cached
hub assets. It applies to editor and app sessions with proxy or subdomain exposure.
Set it to `false` or an empty value to use bundled sandbox assets, including for disconnected deployments.
Leaving it unset keeps the `hub` default.

For internet-connected deployments, use jsDelivr to reduce asset traffic and load
on the hub server:

```bash
MARIMOHUB_COMPUTE_ASSET_URL='https://cdn.jsdelivr.net/npm/@marimo-team/frontend@{version}/dist'
```

Marimo replaces `{version}` with its installed version. The asset origin must
serve each deployed version and receives browser requests directly.

Before production rollout, run these checks in staging:

1. Open an editor and an app. Check workers, WASM, and fonts for CORS or CSP errors.
2. Open a second session. Check cache hits and transferred bytes in DevTools.

The sandbox's CSP must allow the asset origin for scripts, styles, fonts, and
fetches. Cross-origin module workers also need `worker-src blob:`.
The hub SPA's CSP does not control sandbox documents.
If any check fails, set `MARIMOHUB_COMPUTE_ASSET_URL=false`.

## Hub responses

The Node server compresses eligible API and proxied kernel responses with gzip
or deflate. It skips declared bodies smaller than 1 KiB, event streams, range
responses, and already-encoded responses. Unknown-length responses compress
without a size probe. WebSocket upgrades bypass compression.

The frontend build emits Brotli and gzip files when they reduce asset size.
The static server selects these files and retains immutable caching for
fingerprinted assets. The HTML shell stays uncompressed for base URL insertion.

Eligible `/api/v1` JSON GET responses up to 256 KiB receive weak ETags unless the route
already sets one. Matching `If-None-Match` requests return `304 Not Modified`
with cache metadata and no body. `Cache-Control: no-store` disables revalidation
and ETag generation. Generated ETags hash the uncompressed body, allowing reuse
across encodings. Compression weakens strong ETags.

Before rollout, check these behaviors through the deployed ingress:

- API JSON larger than 1 KiB returns gzip when requested and decodes once.
- Chat, host-protocol, and kernel event streams deliver events without buffering.
- The upstream compressor skips responses with `Content-Encoding`.

See [CKS kernel compression](./cks.md#kernel-response-compression) for Traefik configuration.

## Connection capacity

`MARIMOHUB_STORAGE_S3_MAX_SOCKETS` sets the S3 connection limit per origin for
HTTP and HTTPS. It accepts positive safe integers and defaults to 256.
Keep-alive and request deadlines remain unchanged.

GCS and Azure have no equivalent per-client socket-count setting.
See [Kubernetes capacity](./kubernetes.md#hub-resource-capacity) for hub resource limits.
