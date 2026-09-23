---
description: Configure the hub name, logos, favicon, and automatic light and dark palettes.
---

# Customize the hub theme

Customize the hub, sign-in screen, navigation, and browser titles without a frontend rebuild.
Notebook editors and published notebooks keep their own themes.
All theme configuration is public before sign-in.

## Set a primary color

Add a brand color to your server environment:

```dotenv
MARIMOHUB_THEME_PRIMARY_COLOR="#2563eb"
```

Restart the server. Reload the page.
The hub generates light and dark palettes and uses your saved mode, or the operating-system preference if none exists.

Colors accept opaque `#RGB` or `#RRGGBB` values.
Quote hex values in environment files and YAML to avoid comment parsing.
Blank values use defaults. Invalid values stop Node server startup with the variable name and a correction.
On Workers, deployment succeeds, but requests return HTTP 500 with `CONFIG_ERROR` until you correct the configuration.

## Use two brand colors

```dotenv
MARIMOHUB_THEME_NAME="Research Hub"
MARIMOHUB_THEME_PRIMARY_COLOR="#2563eb"
MARIMOHUB_THEME_SECONDARY_COLOR="#7c3aed"
```

The primary color controls actions, links, selection, and focus rings.
The secondary color tints accents and surfaces. Both colors contribute to charts.
Without a secondary color, the hub derives one from the primary.
With only a secondary color, the primary remains the built-in teal.

The hub adjusts OKLCH lightness and saturation, then checks the final sRGB contrast:

- Text against backgrounds: at least 4.5:1.
- Focus rings against adjacent surfaces: at least 3:1.

Displayed colors can differ from your values to meet these targets.
Error, warning, and success colors stay unchanged.

Without color overrides, the palette stays unchanged, even with a custom name or images.

## Add logos and a favicon

```dotenv
MARIMOHUB_THEME_NAME="Research Hub"
MARIMOHUB_THEME_LOGO="https://hub.example.com/brand/logo.svg"
MARIMOHUB_THEME_LOGO_DARK="https://hub.example.com/brand/logo-dark.png"
MARIMOHUB_THEME_FAVICON="https://hub.example.com/brand/favicon.ico"
```

SVG or PNG logos replace the full icon and wordmark and keep their proportions in the header and sign-in screen.
Transparent backgrounds suit both modes.
The deployment name supplies accessible image text and the browser-title suffix.

If the dark logo is absent or cannot load, the hub uses the main logo.
If the main logo cannot load, the hub uses the built-in mark and deployment name.
Favicons accept SVG, PNG, and ICO. Without an override, the built-in favicon stays unchanged.

### Host the assets

Host images over HTTPS or at a same-origin path through your reverse proxy.
Browsers must have access before sign-in.
The hub displays images directly, without uploads, local-file access, server fetches, or inline SVG markup.

Root-relative paths (`/...`) start at the origin root and do not inherit the deployment prefix.
For assets under `https://hub.example.com/tools/hub/`, include the prefix:

```dotenv
MARIMOHUB_THEME_LOGO="/tools/hub/brand/logo.svg"
MARIMOHUB_THEME_FAVICON="/tools/hub/brand/favicon.png"
```

Configure your proxy to serve these paths from your asset directory.
A path such as `/etc/logo.svg` refers to a browser URL, not a server file.
The hub rejects relative paths, plain HTTP URLs, URL credentials, and `data:` URLs.

## Installed app branding

The installed app uses `MARIMOHUB_THEME_NAME` and `MARIMOHUB_THEME_PRIMARY_COLOR`.
The primary color also sets the browser theme color. Without an override, this color remains teal.
Branding changes preserve the installation identity, which depends on the deployment path.
Browsers control when existing installations receive updated names and icons.

Use dedicated square PNG icons for installation:

```dotenv
MARIMOHUB_THEME_PWA_ICON_192="https://hub.example.com/brand/icon-192.png"
MARIMOHUB_THEME_PWA_ICON_512="https://hub.example.com/brand/icon-512.png"
MARIMOHUB_THEME_APPLE_TOUCH_ICON="https://hub.example.com/brand/apple-touch-icon.png"
```

The required dimensions are 192×192, 512×512, and 180×180 pixels, respectively.
Each unset icon uses its built-in default. Favicons and header logos do not replace installation icons.
Custom app icons use the standard icon purpose; only the built-in 512px icon declares maskable support.
The same asset URL rules apply, including explicit prefixes for root-relative paths.

The backend serves `/manifest.webmanifest` and `/apple-touch-icon.png` before sign-in, without response caching.
The latter redirects to the configured Apple touch icon or its default.
For deployments under a URL prefix, include that prefix on both endpoints.
Reverse proxies must forward both endpoints to the backend.

## Cloudflare Workers

Add the same variables to the `vars` object in `wrangler.jsonc`:

```jsonc
{
	"vars": {
		"MARIMOHUB_THEME_NAME": "Research Hub",
		"MARIMOHUB_THEME_PRIMARY_COLOR": "#2563eb",
		"MARIMOHUB_THEME_SECONDARY_COLOR": "#7c3aed",
		"MARIMOHUB_THEME_LOGO": "https://hub.example.com/brand/logo.svg",
		"MARIMOHUB_THEME_LOGO_DARK": "https://hub.example.com/brand/logo-dark.svg",
		"MARIMOHUB_THEME_FAVICON": "https://hub.example.com/brand/favicon.png",
	},
}
```

Keep existing bindings and variables. Redeploy the Worker. Reload the page.
The reference Worker and Node server use the same configuration parser.

## Check the result

1. Open the sign-in screen and a project page.
2. Switch between light and dark mode.
3. Check logos, favicon, titles, buttons, and keyboard focus rings on desktop and mobile.

The public `GET /api/v1/theme` endpoint returns normalized configuration in the standard API envelope.
The browser requests it once per page load, before displaying the UI.
If the response fails, is invalid, or takes over two seconds, the browser uses defaults until the next page load.

For deployments under a URL prefix, include that prefix before `/api/v1/theme`.

For image errors, open the image URL in the browser.
Check that it returns an image, not a sign-in page or hub HTML.
If a replaced image stays cached, change its URL or version query parameter.

See the [configuration reference](./configuration.md#theme) for all theme variables.
