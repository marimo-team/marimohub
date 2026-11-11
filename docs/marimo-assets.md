# Shared marimo assets

By default, each sandbox serves the frontend bundled with its installed marimo
version. This works without an external asset origin. The browser E2E lifecycle
suite exercises this default.

The Node hub can also serve an immutable copy of each runtime's frontend. This
lets browsers reuse assets across sandboxes. The hub does not fetch missing
versions at runtime.

## Stage assets

Use a Python environment with the exact marimo release installed in your sandbox
image. After building the hub, copy that release into its static root:

```sh
node scripts/stage-marimo-assets.mjs /path/to/python packages/web/dist
```

For a container, stage into the directory copied to `/app/public` in the final
image. For local development, set `MARIMOHUB_STATIC_ROOT=packages/web/dist`.
The command copies `marimo/_static` to `_marimo/<installed-version>` and publishes
the directory only after staging succeeds. It adds gzip and Brotli variants for
HTML, JS, MJS, CSS, JSON, SVG, WASM, and TXT files of at least 1 KiB, only when
the compressed result is smaller. Other files, including fonts and raster images,
keep only their original bytes.
It rejects symlinks and refuses to replace an existing version.

Stage every version used by your sandbox images. Custom images can install a
different release from the notebook metadata; always inspect the installed
package. Rebuilding the web frontend removes its output directory, so stage
after each build. Keep previous versions available while their sessions run.

## Enable the origin

```sh
MARIMOHUB_APP_BASE_URL=https://hub.example.com
MARIMOHUB_COMPUTE_ASSET_URL=hub
```

The hub resolves `hub` to `https://hub.example.com/_marimo/{version}` before
launching a sandbox. A deployment prefix in the public base URL is preserved.
The reverse proxy must strip that prefix before forwarding requests to the hub.
The base URL must use HTTP or HTTPS and contain no credentials, query, or fragment.

Alternatively, configure an external versioned origin, such as
`https://assets.example.com/marimo/{version}`. The installed marimo runtime
substitutes its version. Explicit asset URLs require HTTPS without credentials,
query, or fragment. Leave the variable unset, blank, or set it to `false` to use
bundled assets. The `hub` and `false` sentinels are case-insensitive.

## Verify a deployment

Before enabling `hub`, open a sandbox in staging and check its network requests:

- JS, CSS, fonts, workers, and WASM load successfully from the intended version.
- Hashed assets have `Cache-Control: public, max-age=31536000, immutable` and
  `Vary: Accept-Encoding`. HTML and unhashed files revalidate.
- Brotli or gzip requests receive the matching `Content-Encoding`.
- Cross-origin asset requests receive `Access-Control-Allow-Origin: *` and
  `Cross-Origin-Resource-Policy: cross-origin`. Review browser CSP reports.
- A nonexistent version returns 404, rather than the hub's SPA HTML.
- Opening a second sandbox with the same version reuses cached assets.

The browser preconnects to configured HTTPS origins during session admission.
An explicitly pinned URL also permits bounded prefetching of hashed JS and CSS
from its index. Templates only preconnect because the runtime version is not
known before launch. Neither optimization starts a sandbox early.
