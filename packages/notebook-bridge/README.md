# Notebook bridge

`@marimo-hub/notebook-bridge` mirrors notebook query parameters and routes app
links through Hub. Query updates preserve the mounted iframe and kernel connection.
App navigation opens the target through the Hub router. Both features work across
origins without proxy exposure or changes to the iframe sandbox.

## Query mirroring API

```ts
import { createHostBridge } from '@marimo-hub/notebook-bridge/host';
import { startNotebookBridge } from '@marimo-hub/notebook-bridge/notebook';
import { mergeNotebookQuery } from '@marimo-hub/notebook-bridge/query';

// In the parent document:
const notebookUrl = new URL(sandboxUrl, location.origin);
const excludedKeys = [...notebookUrl.searchParams.keys()];
const host = createHostBridge({
	iframe,
	origin: notebookUrl.origin,
	excludedKeys,
	onQuery(snapshot) {
		const search = mergeNotebookQuery(location.search, snapshot.entries, excludedKeys);
		// A router integration must preserve the iframe's launch URL.
		history.replaceState(history.state, '', location.pathname + search + location.hash);
		return true;
	},
	onStatus(status) {
		console.debug(status);
	},
});

// In the notebook document, with an origin supplied by the trusted server:
const notebook = startNotebookBridge({ parentOrigin: 'https://hub.example' });

host.status; // connecting | connected | unavailable | disposed
host.dispose();
notebook.dispose();
```

Both clients expose package-owned interfaces. They do not expose birpc instances.
Repeated notebook initialization returns the existing document observer.
Disposal is idempotent. It closes ports, cancels timers, removes listeners, and
rejects pending requests. History and `attachShadow` restoration preserve wrappers from other scripts.

The notebook observer wraps `pushState` and `replaceState` and listens for
`popstate`. It preserves native arguments, return values, and exceptions. Early
changes remain available until negotiation completes.

## Protocol v1

The protocol version is independent of the npm package and wheel versions.
`protocol` exports the Zod schemas and their inferred types. `query` contains
the shared filtering policy.

1. The host probes the configured iframe. The notebook announces its document ID.
2. Each side checks the exact configured origin and the expected window.
3. The host transfers a MessagePort with a fresh connection ID and the document ID.
4. Both sides require protocol major `1` and capability `query-params.v1`.
5. The host completes the `connected()` RPC before it accepts query snapshots.

Query snapshots contain complete ordered string pairs and increasing revisions. Duplicate
keys, empty values, Unicode, deletion, and clear operations retain their meaning.
Both sides exclude reserved Hub keys and all keys from the original sandbox URL.
Negotiation sends excluded names, never their values.

Snapshots have a limit of 256 pairs and 64 KiB after URL encoding. The client
rejects oversized snapshots without truncation. It sends the latest snapshot at
most every 100 ms, with one request outstanding. The host also limits updates
and rejects stale revisions. Unchanged snapshots do not update the router.

Handshake retries stop after ten seconds. RPC requests time out after five
seconds. A new iframe load starts a new connection. An absent or incompatible
peer leaves the notebook usable, with status `unavailable`. Hub exposes this status
through the iframe `data-notebook-bridge-status` attribute.

### Evolution rules

- Keep existing v1 fields and methods unchanged. Add optional fields and capabilities.
- Accept unknown optional fields and capabilities within major `1`.
- Gate new behavior on a negotiated capability. Never require it from a v1 peer.
- Use a new major for incompatible semantics, and retain the v1 adapter.
- Keep frozen wire fixtures independent of implementation constants and dependency versions.
- Run interoperability tests before any birpc upgrade. The current dependency is pinned to `4.2.0`.

The transport checks JSON envelopes, connection IDs, registered method names,
argument schemas, and response schemas before dispatch. It accepts only registered
methods. Navigation requests can target only validated Hub app slugs.

## Cross-app navigation

Hub enables `app-navigation.v1` for app and editor frames. HTML links can use
`/app/match?id=xyz` or `app/match?id=xyz`. `mo.nav_menu` requires the leading slash:

```python
mo.nav_menu({"/app/match?id=xyz": "Match"})
```

The bridge rewrites recognized anchors to the Hub origin and deployment prefix.
It observes dynamic content and open shadow roots used by marimo plugins.
Default same-tab clicks call `navigateApp({ slug, entries, hash })` on the parent.
Modified clicks and new-tab actions use the rewritten URL directly.
The bridge respects link targets and `<base target>`.

### Host contract

`createHostBridge` enables navigation only when both options are present and the
notebook advertises `app-navigation.v1`:

- `appBaseUrl`: An absolute URL on the configured parent origin, ending in `/app/`.
  It includes the deployment prefix and contains no credentials, query, or fragment.
- `onNavigateApp(destination)`: A synchronous callback with a validated slug,
  filtered query entries, and fragment. `appNavigationHref` from the `navigation`
  export formats this destination as a route.

A `true` result accepts navigation and blocks subsequent queries and navigation
from that connection. The host must replace the iframe, including for the same URL.
A `false` result or thrown error declines navigation and resumes query mirroring.

An RPC timeout disables the connection and restores rewritten links.
A fresh handshake can reconnect it. Older peers retain query mirroring without navigation.

Both endpoints remove reserved parameters and keys from the original sandbox URL.
Application values, duplicate keys, empty values, and fragments remain intact.
Requests allow 256 query pairs and 64 KiB after URL encoding.
Slugs use the core deep-link grammar, with a 63-character limit including separators.
Fragments allow 8,192 characters, including `#`. They reject ASCII whitespace and control characters.

Hub resolves the target through its existing access checks.

Downloads, external URLs, and unrelated paths are not intercepted.
Closed shadow roots, nested iframe documents, form submissions, and programmatic
`location` changes are outside this capability. Standalone sandbox pages and
static exports do not have a parent bridge. Existing sessions need a restart
as described in [runtime installation](#automatic-runtime-installation).

## Automatic runtime installation

The configuration package supplies a narrow runtime payload to core provisioning.
Core writes the payload outside notebook files, after dependency setup and session
file injection. The existing sandbox port performs these operations.

Custom composition roots must set `sandbox.notebookBridge` to
`notebookBridgeRuntime()` from `@marimo-hub/notebook-bridge/runtime` when calling
`createApi`. Omitting the payload disables installation. The Cloudflare Worker
and library-composition examples include this configuration.

For `uv-sync-edit` and `uv-script-pins`, the launch command runs a Python launcher
through the same `uv run` environment as marimo. This also covers local compute,
custom `UV_PROJECT_ENVIRONMENT` paths, and restored sandboxes.

The launcher uses `sys.executable` and installs the bundled wheel with
`uv pip install --no-deps --no-index`. It does not change notebook dependencies
or the installed marimo version. A lock protects shared local environments.
Matching artifact identities skip installation. A changed artifact or a replacement
environment triggers installation again.

Installation has a ten-second limit within the remaining startup deadline.
Failures emit one structured diagnostic without query values, URLs, or credentials.
The launcher then starts the normal marimo CLI with bridge configuration disabled.
The reserved `uv-sandbox` strategy skips installation because marimo selects another
runtime after the CLI starts.

The wheel registers `marimo.server.asgi.lifespan`. Discovery imports no marimo
internals. The extension appends the bundled script to `app.state.html_head`,
preserves existing content, and prevents duplicate injection. Unsupported extension
state does not stop the server.

The integration supports marimo **0.23.10** and **0.24.2**, in app and editor modes.
Other versions can work when they retain the same lifespan and HTML-head contracts.
Scheduled jobs and static exports receive no bridge configuration. An installed
extension remains inert without `MARIMOHUB_BRIDGE_PARENT_ORIGIN`.
Existing sessions acquire the bridge on their next restart. No image rebuild or
npm/PyPI publication is required.

## URL behavior

Notebook changes replace the current Hub query without a frame reload. The route,
deployment prefix, fragment, and Hub-owned query state remain intact. Copy URL
and application links use the current query.

Explicit Hub query navigation retains the existing iframe reload behavior.
Retry and restart use the current shareable parameters and current sandbox credentials.

Query mirroring runs from notebook to Hub. It does not restore Python state
from browser Back/Forward navigation. A fresh app initializes from its query.
An editor reconnect can retain the existing kernel state. Full two-way Python
history restoration requires a separate protocol capability.

## Generation and tests

Generate the browser bundle, deterministic wheel, and embedded payload together:

```sh
pnpm --filter @marimo-hub/notebook-bridge generate
```

Commit `src/runtime.generated.ts` with source changes. Development and server
bundles use this payload without asset downloads. Unit tests include a drift check.

```sh
pnpm --filter @marimo-hub/notebook-bridge test
pnpm --filter @marimo-hub/notebook-bridge test:browser --project=chromium --project=firefox --project=webkit
pnpm --filter @marimo-hub/notebook-bridge test:browser --project=runtime
```

The runtime suite requires `uv` and Chromium. Its marimo environment setup can
download the two supported versions. Wheel installation itself remains offline.
The E2E workflow runs all three browsers and the runtime suite on every pull request.
