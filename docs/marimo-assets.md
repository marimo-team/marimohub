# Shared marimo assets

By default, each sandbox serves the frontend bundled with its installed marimo
version. This default needs no external asset origin.

A shared asset origin lets browsers reuse marimo's frontend across sandboxes.
Set `MARIMOHUB_COMPUTE_ASSET_URL` to one of these values:

| Value                                  | Assets come from                  |
| -------------------------------------- | --------------------------------- |
| Unset, blank, or `false`               | Each sandbox's bundled frontend   |
| `hub`                                  | Pre-staged copies on the Node hub |
| A versioned HTTPS URL with `{version}` | An external origin, such as a CDN |

The `hub` and `false` values are case-insensitive.

## Use an external origin

For internet-connected deployments, use the jsDelivr CDN:

```sh
MARIMOHUB_COMPUTE_ASSET_URL='https://cdn.jsdelivr.net/npm/@marimo-team/frontend@{version}/dist'
```

Keep `{version}` in the URL. The installed marimo runtime substitutes its own
version, which can differ between notebook environments. The origin must contain
every deployed version. The CDN receives browser requests and the marimo version.
Explicit URLs must use HTTPS and contain no credentials, query, or fragment.
Proxy and subdomain exposure both support a shared origin.

## Serve assets from the hub

The `hub` value is an explicit opt-in. The hub serves only versions that you
stage. It does not fetch missing versions at runtime. The official hub image
does not include staged assets.

### Stage assets

Use a Python environment with the exact marimo release of your sandbox image.
After you build the hub, copy that release into its static root:

```sh
node scripts/stage-marimo-assets.mjs /path/to/python packages/web/dist
```

For a container, stage into the directory that the final image copies to
`/app/public`. For local development, set `MARIMOHUB_STATIC_ROOT=packages/web/dist`.

The command copies `marimo/_static` to `_marimo/<installed-version>`. It publishes
the directory only after staging succeeds. It rejects symlinks and does not
replace an existing version. For HTML, JS, MJS, CSS, JSON, SVG, WASM, and TXT
files of 1 KiB or more, it adds gzip and Brotli variants. It keeps a variant only
when it is smaller than the original. Other files keep only their original bytes.

Stage every version that your sandbox images use. Custom images can install a
release that differs from the notebook metadata, so inspect the installed package.
A web frontend build removes its output directory, so stage again after each build.
Keep previous versions available while their sessions run.

### Enable the origin

```sh
MARIMOHUB_APP_BASE_URL=https://hub.example.com
MARIMOHUB_COMPUTE_ASSET_URL=hub
```

Before it launches a sandbox, the hub resolves `hub` to
`https://hub.example.com/_marimo/{version}`. The hub keeps a deployment prefix in
the public base URL. The reverse proxy must remove that prefix before it forwards
requests to the hub. The base URL must use HTTP or HTTPS and contain no
credentials, query, or fragment.

The hub serves only `GET` and `HEAD` requests under `/_marimo/{version}/`.
Staged HTML files, such as `/_marimo/<version>/index.html`, return 404. marimo
pages never run on the hub origin. See
[Asset caching](./deploying/asset-caching.md#hub-responses) for the cache headers.

## Verify a deployment

Before you enable a shared origin in production, open an editor and an app in
staging. Check the network requests in the browser developer tools:

- JS, CSS, fonts, workers, and WASM load from the intended version.
- The console shows no CORS or CSP errors.
- Brotli or gzip requests receive the matching `Content-Encoding`.
- A nonexistent version returns 404, not the hub's SPA HTML.
- A second sandbox with the same version loads assets from the disk or memory cache.

The sandbox CSP must allow the asset origin for scripts, styles, fonts, and
fetches. Cross-origin module workers also need `worker-src blob:`. The hub SPA's
CSP does not control sandbox documents. If a check fails, unset the variable or
set it to `false`.

## Browser hints

During session admission, the browser preconnects to a configured HTTPS origin.
A URL with a fixed version also lets the browser prefetch a bounded set of hashed
JS and CSS files from its index. A `{version}` template only preconnects, because
the runtime version is unknown before launch. Neither hint starts a sandbox early.
