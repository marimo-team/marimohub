# @marimo-hub/web

The web frontend: a React SPA (Tailwind, TanStack Query, React Router) served by the hub.

Part of [marimohub](../../README.md).

## Navigation and session requests

Initial route requests start before lazy page imports. When the server provides
shell prefetches, the client consumes each successful response once, within 30
seconds. Failed or expired prefetches use the normal request path.

The home route fetches one active project. The sidebar loads the full project
roster only when its picker opens. Roster invalidation still follows project changes.

Startup requests long-poll for up to 20 seconds. Running editors receive status
through their two-minute heartbeat; apps use the configured heartbeat interval.
Transient heartbeat failures get three quick retries, then return to intervals of
at least 30 seconds. `Retry-After` can extend either delay. Admission retries are
limited to two, preserve the app visit ID, and exclude capacity, conflict, and
network errors.

`MARIMOHUB_COMPUTE_ASSET_URL` enables early preconnection to a configured HTTPS
asset origin. A URL pinned to an exact version also allows up to 32 hashed JS/CSS
assets from its index to be prefetched during admission. The index request is
limited to five seconds and 512 KiB. Version templates only preconnect: the
installed sandbox version is not known before launch. This optimization remains
optional; check the CDN's caching, CORS, worker/WASM URLs, and CSP in staging.
The [shared asset guide](../../docs/marimo-assets.md) describes staging assets
on the hub and resolving `MARIMOHUB_COMPUTE_ASSET_URL=hub` to a public origin.

The most recent running editor iframe stays mounted for two minutes after navigation.
Its effects pause while hidden. Opening another editor, signing out, or reaching
the retention deadline discards it. Unfinished starts and app visits are not retained.

## Install as an app

Open the hub over HTTPS or localhost, then use the browser's install command.
The app opens in a separate window, with Projects and Apps shortcuts in supported
browsers.

A server connection is required. Offline storage, offline notebook execution, and
push notifications are not included.

## Manifest and icons

The backend serves `/manifest.webmanifest` with the deployment name, primary color,
and app icons. Its identity, launch URL, scope, and shortcuts retain the deployment
prefix, so branding changes preserve the installation.

The manifest request includes credentials for authentication proxies. Launch uses
the existing sign-in flow.

See [theming](../../docs/theming.md#installed-app-branding) for custom app icons.
Apple touch icons and favicons fall back to the 192px PWA icon, then 512px, then their built-in defaults.

`public/icons/app-icon.svg` is the source for the 192px, 512px, and 180px PNG icons. Its opaque
background and centered artwork prevent clipping with icon masks.
