# @marimo-hub/web

The web frontend: a React SPA (Tailwind, TanStack Query, React Router) served by the hub.

Part of [marimohub](../../README.md).

## Install as an app

Open the hub over HTTPS or localhost, then use the browser's install command.
The app opens in a separate window, with Projects and Apps shortcuts in supported
browsers.

A server connection is required. Offline storage, offline notebook execution, and
push notifications are not included.

## Manifest and icons

Relative manifest URLs support deployment paths such as `/marimohub/`. The resolved
`start_url` identifies each installation, so deployments under separate paths remain
distinct. Keep it stable to preserve the app identity.

The manifest request includes credentials for authentication proxies. Launch uses
the existing sign-in flow.

`public/icons/app-icon.svg` is the source for the 192px, 512px, and 180px PNG icons. Its opaque
background and centered artwork prevent clipping with icon masks.
