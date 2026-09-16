# Notebook apps

Serve a notebook as a read-only **application**. An app runs the notebook with
`marimo run` — people using it see the notebook's outputs and interactive
elements (sliders, forms, buttons), never the code or the editor. The editing
workflow is untouched: an app runs alongside edit sessions, in its own sandbox.
App sharing is independent of [editor sandbox sharing](./editor-sessions.md).

## How it works

- **One shared app sandbox, with a separate view for each user.** "Run as app"
  provisions a single app sandbox for that notebook. Every browser uses that
  sandbox's files, credentials, and compute capacity, but gets its own marimo
  session and UI state. One user's inputs and outputs are not mirrored to other
  users. The project page shows who started the shared sandbox, how long it has
  been up, and an approximate count of connected users.
- **Apps serve a point-in-time copy.** The app loads the notebook's saved state
  at start and never writes anything back — no version, no snapshot, no
  workspace change. Interacting with an app cannot modify the notebook. One
  caveat: while an edit session is live, "saved state" includes whatever the
  editor has autosaved since the last version, so an app started mid-edit can
  serve work in progress. Start apps against idle notebooks to get exactly the
  latest version.
- **Editing does not update a running app.** When the notebook changes after
  the app started, the hub marks the app **stale** and offers **Restart**.
  Restarting replaces the sandbox with one serving the current saved state and
  disconnects everyone currently using the app — in-progress input state is
  lost, so the hub asks for confirmation and never restarts automatically.
- **Apps stay up while in use.** Open app tabs keep the session alive. After
  everyone leaves, `MARIMOHUB_SESSION_APP_IDLE_TIMEOUT_SECONDS` controls idle
  reaping. This value inherits `MARIMOHUB_SESSION_IDLE_TIMEOUT_SECONDS` when unset.
  Active connections extend the session deadline. Thus, an open dashboard can
  keep the app and its credentials active, so stop apps that you no longer need.

  The [maintenance worker](./operations.md) handles hub-managed idle reaping and
  the "~N connected" count. Without this worker, the hub does not reap idle apps.
  Provider idle fallbacks and maximum lifetimes can still stop the sandbox. If an
  app stops under an open tab, the page shows the reason.

- **Resource model.** `marimo run` starts one kernel per connected browser
  inside the single app sandbox, so memory scales with concurrent users of that
  app. Size the sandbox for the audience you expect.

Start an app from the notebook's actions menu ("Run as app"), or via the API:
`POST /api/v1/projects/{pid}/notebooks/{nid}/sessions` with body
`{"mode": "app"}`. The call is create-or-reuse: if the app is already running,
any admitted caller attaches to it.

## Notebooks with query parameters

App and editor URLs pass query parameters to the notebook iframe:

```text
/app/<slug>?id=123
/projects/<project-id>/notebooks/<notebook-id>/app?id=123
/projects/<project-id>/notebooks/<notebook-id>?id=123
```

Read them with [`mo.query_params()`](https://docs.marimo.io/api/query_params/).
For these links, `mo.query_params()["id"]` returns `"123"`.

- **Sharing:** Sign-in and **Copy URL** preserve the app or editor URL and its allowed parameters.
  **Run as app** carries allowed parameters from the editor to the app.
  **App links** includes them in alias links, copied URLs, and previews. Slug registrations store no query parameters.
- **App tabs:** Each app tab receives its own parameters. Static outputs and secondary tools receive none.
- **Values:** The iframe URL preserves repeated parameters, empty values, and encoded characters.
  Marimo determines how repeated parameters reach Python.
- **Updates:** `mo.query_params()` changes mirror into the Hub URL without reloading the notebook.
  Copy URL and app links use the current parameters. Explicit Hub query navigation still reloads the iframe while reusing the sandbox.
  Theme changes and stripped parameters do not trigger reloads.

The bridge installs automatically when an app or editor session starts. Existing sessions need a restart.
It supports marimo 0.23.10 and 0.24.2 without proxy exposure or an image rebuild.
Unsupported runtimes continue without synchronization. Static outputs and scheduled jobs receive no bridge configuration.
A fresh app initializes from its query parameters. An editor reconnect can retain existing Python state.
The bridge does not provide full two-way Python history restoration.
See the [bridge package guide](https://github.com/marimo-team/marimohub/blob/main/packages/notebook-bridge/README.md) for runtime and protocol details.

### Reserved parameters

The hub strips these names from forwarded parameters and copied links, including duplicates and encoded names:

- Authentication and session controls: `access_token`, `refresh_token`, `session_id`, `auth_error`.
- Display and runtime controls: `theme`, `show-code`, `include-code`, `kiosk`, `vscode`, `file`, `view-as`, `show-chrome`.

Existing sandbox URL parameters take precedence. The hub then applies its theme and hides code in app mode.
The iframe omits the referrer header to avoid sending the unfiltered outer URL.
Query parameters are user input and grant no access to notebooks or data.

## Who can do what

App users can start and use apps regardless of `MARIMOHUB_VIEWER_MODE`.
Viewer access depends on that setting; editors and higher roles have full app access.

| Action                                       | `app-user` | `viewer`, `static` (default) | `viewer`, `applications` or `ephemeral-sandbox` | `editor` and higher |
| -------------------------------------------- | :--------: | :--------------------------: | :---------------------------------------------: | :-----------------: |
| Start, open, interact, and keep an app alive |     x      |                              |                        x                        |          x          |
| Stop or restart an app                       |            |                              |                                                 |          x          |

Static viewers can see app activity indicators but cannot use apps.
Viewer mode grants no project membership or default role.
The server enforces these permissions on every API request.

## Stakeholders: the App user role

Assign `app-user` to people who need live apps without source access.
The **Apps** gallery at `/apps` lists every active notebook in accessible projects, grouped by project.
App links inherit those permissions. No publishing step is required.

| Capability                                        | App user |
| ------------------------------------------------- | -------- |
| Discover app titles and project names             | Allowed  |
| Start, attach, interact, and send heartbeats      | Allowed  |
| Stop or restart the shared app                    | Denied   |
| Source, workspace files, versions, and saved HTML | Denied   |
| Job outputs and logs                              | Denied   |
| Editors, temporary sandboxes, and terminals       | Denied   |
| Direct integration queries                        | Denied   |
| Manage projects, notebooks, members, or app links | Denied   |

Viewers retain source access and their configured runtime modes, including ephemeral sandboxes.
An explicit viewer membership overrides an app-user default, even when viewer mode is `static`.

Users with only app-user access land in the gallery.
Users with higher roles in other projects retain the normal hub and an **Apps** navigation link.
Permissions apply separately to each project.
App-only users need the `project-creator` entitlement or super-admin status to create a project, even when project creation is open.

### Assignment

Assign the role through any of these mechanisms:

- Project membership: choose **App user** in the member dialog or send `app-user` through the membership API.
- Deployment default: `MARIMOHUB_DEFAULT_ROLE=app-user`.
- OIDC groups: configure the groups claim and set `MARIMOHUB_AUTH_OIDC_DEFAULT_APP_USER_GROUPS=stakeholders`.
- Login policy: return the `default-role:app-user` entitlement.

Set `MARIMOHUB_DEFAULT_ROLE=none` if groups should provide the only deployment-wide role grants.
The highest default grant wins; explicit project membership overrides defaults.

### Source protection and revocation

Apps run with code inclusion disabled. App users receive only app metadata and limited session details.
Authors remain responsible for source or sensitive data that their notebooks display or offer as downloads.
App inputs can use the notebook's configured integrations, secrets, and federated credentials.
Grant app access only to audiences you trust with what the app can compute or fetch.

When a role or viewer-mode change removes app access, the hub blocks new admissions.
Existing access depends on the [sandbox exposure mode](./security.md):

- `proxy`: each kernel request and WebSocket handshake rechecks access.
- `subdomain` (default): previously issued kernel URLs remain usable until the app stops.
  Stop or restart the app to revoke those URLs.

A role change cannot remove source that a former viewer already downloaded.

### Upgrade and rollback

Upgrade all replicas before assigning `app-user` or enabling its default or OIDC mapping.
Older replicas cannot parse the new role.
Existing memberships do not change during the upgrade.

Session responses omit `user_id` for app-only callers, including app-scoped tokens without `project.read`.
Clients must handle its absence. Authorized project readers still receive it.

Before rollback, remove app-user assignments and configuration, or explicitly choose replacement roles.
Do not automatically replace app-user with viewer: viewer grants source access.

### Verification

Run `uv run scripts/test-app-source.py` to check the pinned marimo runtime.
The test checks interaction, bootstrap data, WebSocket messages, error output, source endpoints, and HTML exports.
CI runs this check with the Chromium end-to-end job.

## Configuration

| Variable                          | Effect on apps                                                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `MARIMOHUB_VIEWER_MODE`           | `applications` or `ephemeral-sandbox` enables viewer app access. Default `static` denies it. App users are unaffected. |
| `MARIMOHUB_MAX_APPS_PER_PROJECT`  | Concurrent apps per project (default `5`, `0` = unlimited).                                                            |
| `MARIMOHUB_MAX_SESSIONS_PER_USER` | Also bounds the apps a single user may have _started_, across all projects.                                            |

> **Legacy upgrade note.** Releases introducing app mode also grant app access to existing `ephemeral-sandbox` viewers.
> There is no mode that grants ephemeral editors without shared apps.
> Use `static` if viewers must not reach shared apps, which carry credentials that ephemeral editors never receive.
> Upgrade the maintenance replica first: builds predating app mode treat apps as edit sessions.

See [Configuration](./configuration.md) for the full reference and
[Auth](./auth.md) for roles and viewer modes.

## Gallery thumbnails

Use **Edit thumbnail** to upload and crop a screenshot of your app. See
[Notebook thumbnails](./thumbnails.md) for screenshot shortcuts and automatic previews.
