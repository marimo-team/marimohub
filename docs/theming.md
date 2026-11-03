---
description: Configure branding, navigation, announcements, and notebook colors.
---

# Customize the hub theme

Customize the hub, sign-in screen, navigation, and browser titles without a frontend rebuild.
Notebook editors, served apps, and previews inherit deployment colors and the selected light or dark mode.
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

## Force light or dark mode

Set `MARIMOHUB_THEME_COLOR_MODE` to `light` or `dark`:

```dotenv
MARIMOHUB_THEME_COLOR_MODE="light"
```

The forced mode applies to sign-in, hub pages, and embedded notebooks and apps for every role.
It overrides saved and operating-system preferences and hides the header theme toggle.

To restore user theme selection, set the variable to `user` (the default), or unset it or leave it blank. Saved preferences remain unchanged.
After changing the variable, restart the server and reload the page.

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
Favicons accept SVG, PNG, and ICO. Without an override, the favicon uses the [app icon fallbacks](#installed-app-branding).

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
Each unset PWA icon size uses its built-in default. Apple touch icons and favicons use the first configured asset:

- Apple touch icon: explicit Apple icon → 192px PWA icon → 512px PWA icon → built-in Apple icon.
- Favicon: explicit favicon → 192px PWA icon → 512px PWA icon → built-in favicon.

Favicons and header logos do not replace installation icons. Reused PWA icons retain their original dimensions.
Custom app icons use the standard icon purpose; only the built-in 512px icon declares maskable support.
The same asset URL rules apply, including explicit prefixes for root-relative paths.

The backend serves `/manifest.webmanifest` and `/apple-touch-icon.png` before sign-in, without response caching.
The latter redirects to the selected Apple touch icon or fallback.
For deployments under a URL prefix, include that prefix on both endpoints.
Reverse proxies must forward both endpoints to the backend.

## Shell links and announcements

The hub and app headers share a Help menu. The announcement banner appears in the hub, the editor, and apps.
Configure their contents with these variables:

```dotenv
MARIMOHUB_THEME_NAV_LINKS='[{"label":"Platform","href":"https://platform.example.com"},{"label":"Data catalog","href":"/catalog","roles":["editor","manager","admin"]},{"label":"Status","href":"https://status.example.com","placement":"help"}]'
MARIMOHUB_THEME_DOCS_URL="https://docs.example.com"
MARIMOHUB_THEME_SUPPORT_URL="https://support.example.com"
MARIMOHUB_THEME_ANNOUNCEMENT='{"id":"maintenance-1","text":"Maintenance Friday, 18:00–19:00 UTC","href":"/status","level":"warning","dismissible":true}'
```

Navigation accepts up to 12 links. Each link requires a `label` (1–40 characters) and `href`.
Links use the [asset URL rules](#host-the-assets): HTTPS or root-relative paths, with an explicit deployment prefix.

| Optional field | Behavior                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| `placement`    | `header` (default) or `help`.                                                                                       |
| `external`     | Open a new tab when `true`. Defaults to `true` for HTTPS and `false` for root-relative paths.                       |
| `roles`        | Show the link only for listed roles: `app-user`, `viewer`, `editor`, `manager`, or `admin`. An empty list hides it. |

Project pages use the project role. Other pages use the deployment default role.
App-only users use `app-user`; super admins use `admin`.
Role filters match the listed roles exactly: a link for `["editor"]` is hidden from managers and admins.
Role-specific links stay hidden until the role is known.
If a project or deployment role lookup fails, its role-specific links stay hidden until the next successful lookup.
**All links are public configuration.** Role filters control visibility, not access to the destination.

Help includes Documentation, optional Get help and custom links, **Report a problem** (always present; see [Support](./support.md)), and About with version and source links.
`MARIMOHUB_THEME_SUPPORT_URL` sets the Get help target. It also sets the sign-in "Contact your administrator" link and the problem-report portal link.
`MARIMOHUB_THEME_DOCS_URL` replaces the Help documentation target. Feature-specific documentation links keep their upstream targets.
Without this override, Help links to the upstream documentation.

Announcements require an `id` (1–100 characters) and `text` (1–280 characters).
Optional fields are `href`, `level` (`info` by default, or `warning`), and `dismissible` (`false` by default).
Dismissal persists in browser storage by ID. Change the ID to show a dismissed announcement again.
Without browser storage, dismissal lasts until the banner reloads.

Restart the server and reload the page to apply changes.

## Colors in notebooks and apps

New editor, app, and preview sessions inherit the hub palette. Existing sessions need a restart to apply changes.
Without color overrides or notebook CSS, marimo keeps its native palette. Scheduled jobs do not receive deployment CSS.

For additional styles, configure a public stylesheet:

```dotenv
MARIMOHUB_THEME_NOTEBOOK_CSS="https://hub.example.com/brand/notebook.css"
```

The API downloads the stylesheet and appends it after the palette CSS.
Root-relative paths resolve against `MARIMOHUB_APP_BASE_URL`, which must be an absolute HTTP(S) URL without credentials.
Host the stylesheet on infrastructure you control; it runs inside the notebook page and can load remote assets.
The file must contain UTF-8 text of at most 64 KiB.
A response without a `Content-Type` header is accepted. If the header is present, its media type must be exactly `text/css`; parameters such as `charset` are allowed.
The download has a five-second timeout and rejects redirects.
The API caches CSS for one minute, then revalidates it with its ETag when available.
If the stylesheet cannot be revalidated, the hub serves the last fetched copy. Session starts fail only when it was never fetched.
Use absolute asset URLs in CSS: marimo serves the copied stylesheet from the notebook origin.

The palette sets marimo's `--primary`, `--secondary`, `--link`, and related surface variables.
Custom CSS, workspace configuration, and chart libraries can override these colors.
See the [marimo theming guide](https://docs.marimo.io/guides/configuration/theming/) for version-specific variables.

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
2. Switch between light and dark mode, or check that the forced mode hides the theme toggle.
3. Check logos, favicon, titles, buttons, and keyboard focus rings on desktop and mobile.

The public `GET /api/v1/theme` endpoint returns normalized configuration in the standard API envelope.
The browser requests it once per page load, before displaying the UI.
If the response fails, is invalid, or takes over two seconds, the browser uses defaults until the next page load.
This fallback uses the saved or operating-system mode, without a theme override.

For deployments under a URL prefix, include that prefix before `/api/v1/theme`.

For image errors, open the image URL in the browser.
Check that it returns an image, not a sign-in page or hub HTML.
If a replaced image stays cached, change its URL or version query parameter.

See the [configuration reference](./configuration.md#theme) for all theme variables.
