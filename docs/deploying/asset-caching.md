---
description: Share marimo assets across sessions and configure response compression.
---

# Asset caching and compression

Each sandbox has a different origin or session path. A shared asset URL lets
browsers reuse marimo's frontend across sessions and projects.

## Shared marimo assets

For internet-connected deployments, set:

```bash
MARIMOHUB_COMPUTE_ASSET_URL='https://cdn.jsdelivr.net/npm/@marimo-team/frontend@{version}/dist'
```

Keep `{version}`: marimo substitutes its installed version, which can differ
between notebook environments. The CDN must contain each deployed version.
This setting supports both proxy and subdomain exposure.

The CDN receives browser requests and the marimo version. For disconnected
deployments, leave the setting unset to use each sandbox's bundled assets.

Before production rollout, run these checks in staging:

1. Open an editor and an app with the setting enabled.
2. Load workers, WASM, and fonts without CORS or CSP errors.
3. Open a second session and check for disk or memory cache hits in DevTools.
4. Compare transferred bytes between the two sessions.

The sandbox's CSP must allow the asset origin for scripts, styles, fonts, and
fetches. Cross-origin module workers also need `worker-src blob:`.
The hub SPA's CSP does not control sandbox documents.
If any check fails, leave the setting unset.

## Hub responses

The Node server compresses eligible API and proxied kernel responses with gzip
or deflate. It skips declared bodies smaller than 1 KiB, event streams, range
responses, and already-encoded responses. Unknown-length responses compress
without a size probe. WebSocket upgrades bypass compression.

The frontend build emits Brotli and gzip files when they reduce asset size.
The static server selects these files and retains immutable caching for
fingerprinted assets. The HTML shell stays uncompressed for base URL insertion.

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
