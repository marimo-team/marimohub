# Notebook previews

A preview publishes GitHub code through an existing notebook, with a stable share URL and separate, disposable compute.
Managers and admins can create and delete previews. Sharing a URL does not grant notebook access.

::: warning Previews run branch code with the notebook's credentials
A preview runs the code at the chosen branch or commit with the parent notebook's integrations and secrets.
Anyone who can push to a previewed branch can supply code that uses these credentials.
PR automation previews same-repository PR branches, except Dependabot PRs and runs with an empty `hub-token`.
Protect previewed branches, or pin a reviewed commit. See [Security model → Previews](security.md#previews).
:::

## Automatic PR previews

Select **Set up GitHub Action** on the notebook's **Previews** page to generate a workflow and token instructions.
The [Action README](https://github.com/marimo-team/marimohub/tree/main/actions/preview) describes the Action inputs, workflow, PR comment, outputs, and version pinning.
This section describes how the Hub manages the previews that the Action requests.

### Lifecycle

Each workflow event sends a reconcile request for one PR and notebook. The request includes a retention policy:

| Policy         | Behavior                                                                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sticky` mode  | One `<branch>` preview with a stable URL that follows PR updates                                                                                                       |
| `commits` mode | Separate `<branch>-<12-character-sha>` previews for the latest distinct pushed heads. Long branches use a truncated name and deterministic hash before the commit SHA. |
| `keep`         | Number of commit previews to retain, from 1 to 25                                                                                                                      |
| `eager`        | Prepare code after each update, or defer until an authorized visit                                                                                                     |
| `idle_days`    | Expire after 1–30 days without a new head. If unset, previews remain until the PR closes.                                                                              |

Each workflow event selects the full head SHA to prepare. The Hub prepares that commit, even if the branch advances before preparation starts.
Managed previews do not poll the branch for newer commits.
Missed or canceled runs do not create targets. Commit retention uses the original event order, not arrival or rerun time.
New heads renew inactivity for all retained previews. Reruns do not.
A new commit after expiry or a reopened PR starts a new lifecycle.
Changing modes retires the previous mode's previews. Manual previews remain separate.
Closing or merging the PR retires its managed previews.
Deleting the notebook or project closes its PR groups.

With `eager` off, each new target waits for an authorized visit.
After that visit, preparation retries automatically within the [retry limits](#preparation-retries).
Compute starts when a user opens an app or editor.

Managed previews share the project preview limit with manual previews.
If the project has no free capacity, the Hub retries later without a new commit.
See [Operation and limits](#operation-and-limits) for all limits.

### PR closure checks

Maintenance checks each active PR group on GitHub about once a minute, including lazy groups.
The maintenance replica schedules these checks in memory.
If a check finds the PR still open, the Hub records the check time at most once an hour.
These checks close groups when the workflow misses the close event.
GitHub outages delay closure checks. Configured inactivity expiry still applies.
If checks fail for seven days, the Hub closes the group and retires its previews.
The seven days start at the last successful check or the last new head.
This fallback stops previews when the GitHub App loses access to the repository.

## Create a preview

Open **Previews** from the notebook menu. Select **Create preview**.
Previews require a [Git-synced notebook](syncing.md) and a [GitHub App connection](syncing.md#pull-mode-connect-a-repository) with access to the notebook's configured repository.
Configuring the [GitHub App](configuration.md#github-app) enables previews.
Previews use the deployment's GitHub host, including a [GitHub Enterprise Server](syncing.md#github-enterprise-server) instance.
[GitHub project policies](syncing.md#repository-project-policies) apply to preview reads.
Pull request tracking also needs the App's Pull requests read permission, in addition to Contents read.

- **Follow a branch** publishes the current commit and follows new pushes.
- **Pin to a commit** publishes a full, 40-character SHA. Future pushes do not change it.

GitHub suggestions show up to 30 matches from the first 100 branches or recent commits.
You can enter a branch or full SHA manually, including when suggestions fail.

Previews inherit integrations and secrets, including credential rotation. Existing restrictions on [temporary viewer editors](apps.md#who-can-do-what) still apply.
Pinning freezes code only.

## Run and share

Copy the link from the preview list or header. Existing notebook permissions determine access:

- App-users can run apps.
- Viewers can use modes allowed by the deployment's [viewer configuration](apps.md#who-can-do-what).
- Editors, managers, and admins can open personal [temporary editors](editor-sessions.md#exclusive-mode).

Temporary edits stay in the sandbox. They never update notebook history, workspace storage, GitHub, or the published preview.
Preview editors have no persistent personal home. Authorized integrations still permit access to external systems.

New sessions use the latest successfully prepared revision. Running sessions keep their original revision and edits.
The page indicates newer revisions. **Discard edits and open latest** replaces a temporary editor.
If an update fails, the page displays an error and keeps the previous revision available.

Preview session responses identify the parent notebook in `notebook_id` and include an application-relative `resource_path` to the preview.
Use the parent notebook ID with the normal session get, heartbeat, stop, surface, and app-visit endpoints.
The hidden workspace ID stays internal.

The session's immutable `origin` records `type: "preview"`, `notebook_id`, `preview_id`, `revision_id`, and `commit`.
Use `origin.revision_id` to identify its prepared revision; preview responses omit `source_version_id`.
Branch updates do not change existing session provenance. Reused app sessions retain their original provenance.
Authorized session history retains this association after preview and workspace cleanup, for the normal session retention period.
History reads check current parent permissions. Live operations also require an active preview.

## API and CLI

Preview endpoints use this base path:

```text
/api/v1/projects/{pid}/notebooks/{nid}/previews
```

| Method and suffix       | Operation                                      |
| ----------------------- | ---------------------------------------------- |
| `POST` (base)           | Create a manual preview                        |
| `GET` (base)            | List previews                                  |
| `GET /{prid}`           | Read a preview                                 |
| `DELETE /{prid}`        | Revoke a preview                               |
| `POST /reconcile`       | Apply a PR workflow event and retention policy |
| `POST /{prid}/prepare`  | Request preparation without starting compute   |
| `POST /{prid}/sessions` | Open an app or temporary editor                |

Preview IDs use the `prev-` prefix, for example `prev-7h2k9qm4xz7rp3w8`.
List and get requests never trigger preparation. The prepare endpoint requires permission to launch an app or temporary editor.

Source suggestions use `GET /api/v1/projects/{pid}/notebooks/{nid}/source/refs`.
The `type` parameter accepts `branch` or `commit`. The optional `query` parameter filters suggestions and defaults to an empty string.

The reconcile response `state` is `active`, `closed`, or `expired`. Clients must also accept `unknown`, which represents states that later versions add.
Only the Action calls reconcile, so the CLI does not expose it.
The generated [CLI](cli.md#use-the-cli) exposes the other operations:

```sh
mohub notebooks previews create --pid "$PROJECT" --nid "$NOTEBOOK" \
  --name 'Chart review' --source '{"type":"branch","branch":"feature/chart"}' \
  --idempotency-key 'chart-review-pr-42' --pull-request 42

mohub notebooks previews create --pid "$PROJECT" --nid "$NOTEBOOK" \
  --name 'Release review' --source '{"type":"commit","commit":"0123456789abcdef0123456789abcdef01234567"}'

mohub notebooks previews delete --pid "$PROJECT" --nid "$NOTEBOOK" \
  --prid "$PREVIEW" --yes
```

Creation returns `202` with a preview and its share URL. For lazy previews, request preparation before polling for a ready revision.
Launches return `409 PREVIEW_NOT_READY` until then. Delete returns `202` after revoking access; cleanup runs asynchronously.
List responses use `data.items` and `data.next_cursor`, with `limit` and `cursor` query parameters.
Manual previews always have a finite `expires_at`.
Action-managed previews without `idle_days` return `expires_at: null` until the PR closes.

Idempotency keys are retained for seven days from creation, scoped to the caller and notebook.
During that window, retries return the same preview. Changed requests and deleted previews return a conflict.
After the window, reusing a key creates a new preview. CI should retain the preview ID for deletion.
API tokens need the corresponding project grants and actions. Management and source suggestions require `preview.manage`.
Session creation accepts a mode without a ref override.

Optional `pull_request` tracking retires a preview after its PR closes or merges. Branch previews must select the PR's head branch.
Fork PRs and built-in label triggers are unsupported. Preparation fails if a tracked PR's head branch is not in the notebook's repository. CI can use the API or CLI to create and delete previews on label changes.

## Operation and limits

The Node preparation worker runs independently every 15 seconds on maintenance replicas.
It checks manual branch previews at most once per minute and selects one due preview per project.
Maintenance checks PR closure independently of preparation. See [PR closure checks](#pr-closure-checks).
Each tick visits up to four projects with outstanding preview work.
Up to three slots go to queued projects with new or requested work. At least one slot advances the rotation through projects.
A project whose scheduled work fails is queued once more. If that retry also fails, the project waits for the rotation.
Empty retained project records do not participate in scheduling.
Manual creation and session launch never wait for GitHub. PR reconciliation checks live PR metadata before accepting an event.

Preparation has a two-minute lease and aborts network requests before that deadline.
Failed attempts retry with backoff. See [Preparation retries](#preparation-retries).
At most four preparations run per deployment, with one per project.
During a rolling upgrade, replicas that run v0.6.4 or earlier drop the queue from `_system/preview-work.json` when they write it.
This affects only priority order. The rotation still reaches every project.
The reference Cloudflare Worker does not configure a GitHub App registry or run preparation.
Previews are unavailable in that example. A custom Worker deployment must configure both before enabling previews.
Automatic updates, expiry, and cleanup require maintenance.

Manual previews expire after seven days by default, with an API maximum of 30 days.
Action-managed previews last until the PR closes or the optional inactivity timeout ends.
Deletion immediately blocks access. Cleanup waits for starting sessions and retries failed destruction.
Deleting a parent notebook or project also retires its previews.

`MARIMOHUB_NOTEBOOK_PREVIEW_COMPUTE_PROFILE` sets the default [compute profile](configuration.md#compute) for all preview modes.
If unset, previews use the deployment default, ignoring the notebook's compute profile.
If deployment configuration permits overrides, managers can select another allowed profile.

Each preview permits ten active sessions across users and revisions, with at most two [app replicas](app-pools.md) per revision.
Lower deployment limits still apply. Idle retirement uses five minutes, subject to active connections and app visits.
Cleanup removes unused revisions after reclaiming their sessions.

A project can own up to 25 previews, including previews awaiting cleanup.
Each project can have up to 1,000 active automation groups, including groups waiting for preview capacity.
Retired groups retain compact replay records outside that limit, so delayed events cannot restore retired previews.
Each preview can retain up to 12 revisions; a project has a 500 MiB workspace budget.
Preparation reserves the maximum archive size before download, then charges the stored workspace size.
Reservations remain until cleanup confirms reclamation. Unpublished artifacts have a 15-minute cleanup grace period.
A project can retain up to 1,000 idempotency receipts within the seven-day window.
After a capacity rejection, retry with the same key once capacity becomes available.
Each retry gets a fresh creation deadline; deleted previews cannot be recreated with their retained key.
Limits return `429 RESOURCE_EXHAUSTED`.

### Preparation retries

After each failure, preparation waits about 1, 2, 4, 8, then 16 minutes, with ±25% jitter.
It stops after five consecutive failures, including expired worker leases.
It then logs `preview_preparation_exhausted`.
The last prepared revision remains available.

**Prepare latest** or the preparation API restarts attempts after the retry delay and resets the failure count.
Opening a failed preview does not restart attempts.
PR automation resets the failure count only when the target commit changes.
