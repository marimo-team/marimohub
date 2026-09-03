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
  keep the app and its credentials active indefinitely.

  The [maintenance worker](./operations.md) handles idle reaping and the "~N
  connected" count. Without this worker, apps stay up until someone stops them.
  If an app stops under an open tab, the page shows the reason. The session
  maximum lifetime can stop an app before its idle timeout.

- **Resource model.** `marimo run` starts one kernel per connected browser
  inside the single app sandbox, so memory scales with concurrent users of that
  app. Size the sandbox for the audience you expect.

Start an app from the notebook's actions menu ("Run as app"), or via the API:
`POST /api/v1/projects/{pid}/notebooks/{nid}/sessions` with body
`{"mode": "app"}`. The call is create-or-reuse: if the app is already running,
any admitted caller attaches to it.

## Who can do what

Editors, managers, and admins always have full app access. What a **viewer** gets is a
deployment decision, set by
[`MARIMOHUB_VIEWER_MODE`](./auth.md#what-viewers-see-marimohub_viewer_mode)
(each tier includes the previous one):

| Action                                 | `viewer`, `static` (default) | `viewer`, `applications` | `viewer`, `ephemeral-sandbox` | `editor` | `manager` | `admin` |
| -------------------------------------- | :--------------------------: | :----------------------: | :---------------------------: | :------: | :-------: | :-----: |
| See that an app is running (indicator) |              x               |            x             |               x               |    x     |     x     |    x    |
| Open and use a running app             |                              |            x             |               x               |    x     |     x     |    x    |
| Start the app when none is running     |                              |            x             |               x               |    x     |     x     |    x    |
| Keep the app alive by having it open   |                              |            x             |               x               |    x     |     x     |    x    |
| Stop or restart the app                |                              |                          |                               |    x     |     x     |    x    |

Session create, heartbeat, and session listing enforce this server-side on
every request; the UI simply hides what the caller cannot do. How kernel
traffic itself is gated depends on the
[sandbox exposure mode](./security.md): under `proxy` exposure every kernel
request (and each WebSocket handshake) re-checks the caller's role; under
`subdomain` exposure (the default) the kernel URL is itself the access
capability — it is only revealed to admitted callers, but whoever already
holds it can keep using the running app. Revoking a member or downgrading
`MARIMOHUB_VIEWER_MODE` always stops new admissions; under `subdomain`
exposure, stop or restart the app to cut off someone already holding its URL.
Membership still applies: under `MARIMOHUB_DEFAULT_ROLE=none`, a non-member
gets nothing from `applications` — only explicit members with at least the
`viewer` role are admitted.

> **Security note.** The app kernel runs the notebook's code with resolved
> [integration secrets](./integration-secrets.md) and federated credentials injected,
> regardless of who opened the app. An app's inputs drive that code, so
> enabling viewer access means trusting your viewer audience with everything
> the app can compute or fetch. That is why apps are editor-only by default.

## Configuration

| Variable                          | Effect on apps                                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `MARIMOHUB_VIEWER_MODE`           | `applications` (or `ephemeral-sandbox`) lets viewers start, open, and use apps. Default `static` — editor-only. |
| `MARIMOHUB_MAX_APPS_PER_PROJECT`  | Concurrent apps per project (default `5`, `0` = unlimited).                                                     |
| `MARIMOHUB_MAX_SESSIONS_PER_USER` | Also bounds the apps a single user may have _started_, across all projects.                                     |

> **Upgrade note.** `ephemeral-sandbox` is a superset of `applications`:
> deployments already running `MARIMOHUB_VIEWER_MODE=ephemeral-sandbox` grant
> their viewers app access as of this release, with no configuration change.
> There is deliberately no tier that grants throwaway edit sandboxes without
> apps — if your viewers must not reach shared apps (apps carry the project's
> secrets and federated credentials; ephemeral edit sandboxes never do), the
> only option is `static`. When rolling out this release, upgrade the
> maintenance replica first: an older maintenance build does not know the
> `mode` field and would treat a running app as an edit session.

See [Configuration](./configuration.md) for the full reference and
[Auth](./auth.md) for roles and viewer modes.
