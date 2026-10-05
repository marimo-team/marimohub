# Notebook previews

A preview publishes GitHub code through an existing notebook, with a stable share URL and separate, disposable compute.
Managers and admins can create and delete previews. Sharing a URL does not grant notebook access.

## Create a preview

Open **Previews** from the notebook menu. Select **Create preview**.
Previews require a GitHub App connection with access to the notebook's configured repository.

- **Follow a branch** publishes the current commit and follows new pushes.
- **Pin to a commit** publishes a full, 40-character SHA. Future pushes do not change it.

GitHub suggestions show up to 30 matches from the first 100 branches or recent commits.
You can enter a branch or full SHA manually, including when suggestions fail.

Previews inherit integrations and secrets, including credential rotation. Existing restrictions on temporary viewer editors still apply.
Pinning freezes code only.

## Run and share

Copy the link from the preview list or header. Existing notebook permissions determine access:

- App-users can run apps.
- Viewers can use modes allowed by the deployment's viewer configuration.
- Editors, managers, and admins can open personal temporary editors.

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

Create, list, get, delete, and session creation endpoints use this base path:

```text
/api/v1/projects/{pid}/notebooks/{nid}/previews
```

Source suggestions use `GET /api/v1/projects/{pid}/notebooks/{nid}/source/refs`.
The `type` parameter accepts `branch` or `commit`. The optional `query` parameter filters suggestions and defaults to an empty string.
For example, `?type=branch&query=feature` returns matching branches:

```json
{
	"success": true,
	"data": [
		{
			"value": "feature/chart",
			"commit": "0123456789abcdef0123456789abcdef01234567",
			"label": "feature/chart"
		}
	]
}
```

With `resolve=true`, the endpoint resolves one reference instead of searching for suggestions. This requires a nonblank `query` and returns the same response shape.

The generated CLI exposes the same operations:

```sh
mohub notebooks previews create --pid "$PROJECT" --nid "$NOTEBOOK" \
  --name 'Chart review' --source '{"type":"branch","branch":"feature/chart"}' \
  --idempotency-key 'chart-review-pr-42' --pull-request 42

mohub notebooks previews create --pid "$PROJECT" --nid "$NOTEBOOK" \
  --name 'Release review' --source '{"type":"commit","commit":"0123456789abcdef0123456789abcdef01234567"}'

mohub notebooks previews delete --pid "$PROJECT" --nid "$NOTEBOOK" \
  --preview-id "$PREVIEW" --yes
```

Creation returns `202` with a pending preview and its share URL. Poll the get endpoint until a revision is prepared.
Launches return `409 PREVIEW_NOT_READY` until then. Delete returns `202` after revoking access; cleanup runs asynchronously.
List responses use `data.items` and `data.next_cursor`, with `limit` and `cursor` query parameters.

Idempotency keys are retained for seven days from creation, scoped to the caller and notebook.
During that window, retries return the same preview. Changed requests and deleted previews return a conflict.
After the window, reusing a key creates a new preview. CI should retain the preview ID for deletion.
API tokens need the corresponding project grants and actions. Management and source suggestions require `preview.manage`.
Session creation accepts a mode without a ref override.

Optional `pull_request` tracking retires a preview after its PR closes or merges. Branch previews must select the PR's head branch.
Fork PRs and automatic label triggers are unsupported. CI can use the API or CLI to create and delete previews on label changes.

## Operation and limits

The Node preparation worker runs independently every 15 seconds on maintenance replicas.
It checks moving sources at most once per minute and selects one due preview per project.
Each tick visits up to four projects with outstanding preview work, rotating through projects and due previews.
Empty retained project records do not participate in scheduling.
Creation and session launch never wait for GitHub. Failed refreshes leave the last prepared revision available.

Preparation has a two-minute lease and aborts network requests before that deadline.
Failures retry with exponential backoff and jitter, capped near one hour.
At most four preparations run per deployment, with one per project.
The reference Cloudflare Worker does not configure a GitHub App registry or run preparation.
Previews are unavailable in that example. A custom Worker deployment must configure both before enabling previews.
Automatic updates, expiry, and cleanup require maintenance.

Previews expire after seven days by default, with an API maximum of 30 days.
Deletion immediately blocks access. Cleanup waits for starting sessions and retries failed destruction.
Deleting a parent notebook or project also retires its previews.

`MARIMOHUB_PREVIEW_COMPUTE_PROFILE` sets the default profile for all preview modes.
If unset, previews use the deployment default, ignoring the notebook's compute profile.
If deployment configuration permits overrides, managers can select another allowed profile.

Each preview permits ten active sessions across users and revisions, with at most two app replicas per revision.
Lower deployment limits still apply. Idle retirement uses five minutes, subject to active connections and app visits.
Cleanup removes unused revisions after reclaiming their sessions.

A project can own up to 25 previews, including previews awaiting cleanup.
Each preview can retain up to 12 revisions; a project has a 500 MiB workspace budget.
Preparation reserves the maximum archive size before download, then charges the stored workspace size.
Reservations remain until cleanup confirms reclamation. Unpublished artifacts have a 15-minute cleanup grace period.
A project can retain up to 1,000 idempotency receipts within the seven-day window.
After a capacity rejection, retry with the same key once capacity becomes available.
Each retry gets a fresh creation deadline; deleted previews cannot be recreated with their retained key.
Limits return `429 RESOURCE_EXHAUSTED`; preparation failures retry after backoff.
