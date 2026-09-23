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

The backend serves `/manifest.webmanifest` with the deployment name, primary color,
and app icons. Its identity, launch URL, scope, and shortcuts retain the deployment
prefix, so branding changes preserve the installation.

The manifest request includes credentials for authentication proxies. Launch uses
the existing sign-in flow.

See [theming](../../docs/theming.md#installed-app-branding) for custom app icons.
Apple touch icons and favicons fall back to the 192px PWA icon, then 512px, then their built-in defaults.

`public/icons/app-icon.svg` is the source for the 192px, 512px, and 180px PNG icons. Its opaque
background and centered artwork prevent clipping with icon masks.
