# Source-control publishing

marimohub can publish edits from a git-synced notebook as a provider change request. The
adapters create draft pull requests through GitHub Apps or Azure DevOps identities, and draft merge
requests through GitLab access tokens. Capture is provider-neutral and can include multiple added,
modified, or deleted files.

## Trust boundary

The notebook sandbox is an untrusted content producer. It can supply changed file bytes, but it
never receives provider credentials. The
control plane validates the session and project role, records an immutable proposal, and asks a
server-side publisher adapter to perform the provider API calls.

Opening a change request requires all of the following:

- the caller has the project `manager` or `admin` role;
- the session is a running, persistent edit session;
- the session was created from an immutable git-synced version;
- the captured workspace differs from that version; and
- a publisher for the version's provider is configured.

The API uses the session's source version and commit, not the notebook's current head. A push that
lands while someone is editing therefore cannot silently move the proposed change onto a different
base.

Commits keep the configured provider integration as the committer and add the authenticated user as
a `Co-authored-by` identity. Attribution is currently always enabled. The provider port keeps the
identity optional so a future deployment setting can disable it without changing stored proposals.

The endpoint is
`POST /api/v1/projects/{pid}/notebooks/{nid}/sessions/{sid}/change-requests`. It requires an
`Idempotency-Key` header. The key determines a stable proposal id and provider branch, so retrying
after a timeout or partial provider failure resumes the same publication instead of creating a
second provider change request. By default, the endpoint creates a new change request. Supplying a
published proposal as `target_proposal_id` captures a new immutable proposal and publishes it to
that proposal's existing change request.

## Capture strategies

Capture selects one of two strategies automatically and records the choice in
`proposal.json.capture_strategy`:

- `git-working-tree`: selected when the session work directory contains `.git` and the `git` binary
  is available. The session's pinned source commit must resolve in that repository. marimohub runs a
  NUL-delimited `git diff --name-status --no-renames <source-commit>` and adds untracked files from
  `git ls-files --others --exclude-standard`. This includes commits made after the session started,
  staged and unstaged changes, deletions, and untracked files while honoring `.gitignore`.
- `entry-notebook`: the fallback for sandboxes without that Git context. It compares only the
  configured entry notebook with the immutable source version, preserving compatibility with
  copy-based sandbox backends.

Pull-mode sources store a shallow Git directory for the exact synced
commit. The control plane restores it when the session starts. Repository
credentials never enter the sandbox. Pull sources therefore use
`git-working-tree`. Push sources use this strategy only when the uploaded archive
contains `.git`. Restored `.git` metadata may be owned by a different uid than
the kernel user (Modal filesystem writes), so capture passes
`-c safe.directory=<workdir>` and provision marks that directory in the sandbox
gitconfig.

The Git strategy uses Git only to discover paths and operations. The control plane reads the final
file bytes through the sandbox port, hashes them, and stores normal provider-neutral proposal
changes; it does not trust or persist an opaque patch. Tracked modifications and deletions must
exist in the immutable source version. New regular files can be added. Source ingest omits
symlinks and other special files. Capture ignores their missing index entries. It also ignores
mode-only changes because the proposal format stores content only.

Capture is limited to 1,000 changes and 10 MiB of combined content. It excludes `.git`,
`__marimo__`, `.venv`, `__pycache__`, `node_modules`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`,
`.ipynb_checkpoints`, and `.DS_Store` at any depth. Once Git capture is selected, a missing pinned
commit or Git inspection failure aborts the request rather than silently reducing it to an
entry-notebook-only proposal.

## GitHub App setup

For credentials, permissions, and repository policies, see the
[GitHub App configuration](../docs/configuration.md#github-app) and
[GHES setup](../docs/syncing.md#github-enterprise-server).

GHES must support REST API version `2022-11-28`, draft PRs, and GraphQL `updateRefs`
for conditional branch replacement. Tests use injected responses; a minimum GHES
release has not been verified against a live installation. References:
[REST archives](https://docs.github.com/en/enterprise-server%403.19/rest/repos/contents?apiVersion=2022-11-28#download-a-repository-archive-tar)
and [GraphQL](https://docs.github.com/en/enterprise-server%403.19/graphql/guides/using-graphql-clients).

The GitHub App supports publishing and
[server sync](../docs/syncing.md#sync-now). Project editors can
compare a synced notebook with its branch head and pull that commit on demand. Pulls use the same
workspace parser and limits as pushed archives. The drift and sync endpoints always use the
source coordinates stored on the notebook. They do not accept a repository from the caller.

The App installation limits repository access. The optional
`MARIMOHUB_SOURCE_CONTROL_GITHUB_ALLOWED_REPOSITORIES` policy further restricts
access by project. Rules include the repository host. See
[repository project policies](../docs/syncing.md#repository-project-policies).

The adapter discovers the installation for the target repository and creates a short-lived token.
The token is restricted to that repository and to the configured App permissions. During
publication, the adapter creates blobs, a tree, and a commit from the exact synced commit. It then
creates a deterministic
`marimohub/<notebook-id>/<proposal-id>` branch and draft pull request. Retrying publication of the
same proposal returns the existing pull request.

An update normally appends a commit to the existing pull-request branch. If the captured file
operations no longer apply to that branch, the adapter rebuilds the proposal from its original
base and attempts a force update. The force update is conditional on the branch still pointing to
the commit marimohub previously published, so collaborator or automation changes are never
overwritten. After the branch update, the adapter also updates the existing pull request's title
and description. A metadata failure is retryable without creating another commit. A closed pull
request or deleted branch must be replaced with a new pull request.

## Azure DevOps Services

See [Azure setup](../docs/syncing.md#azure-devops-services) for identity and repository policy configuration.
The adapter uses REST API 7.1 with Microsoft Entra tokens. Repository URL resolution,
credentials, and HTTP requests remain separate so Server support can add collection URLs later.

Pushes compare the branch head with the last published commit. Updates calculate the complete
proposal tree from its original base, including restoration of omitted changes.
Retries require both the expected parent and matching tree before reusing a commit.
The adapter rejects external branch changes, closed PRs, and unsupported file-mode changes.
It never force-pushes. Workspace and Git downloads share the existing size limits.

## GitLab

Token and policy setup is in [GitLab](../docs/syncing.md#gitlab). Prefer a project or group access
token; a personal token reaches every project its user can access. The adapter uses REST API v4 for
branches, trees, and merge requests, and pushes commits over smart HTTP through the shared Git
transport. It supports gitlab.com and one self-managed origin.

Publication pushes a commit built from the exact synced commit to the deterministic
`marimohub/<notebook-id>/<proposal-id>` branch, then opens a `Draft: …` merge request. The push is
conditional on the expected branch head, so a retry reuses the branch and merge request. Updates
compute the complete proposal tree from its original base, restoring omitted changes. The adapter
rejects external branch changes, deleted branches, and closed merge requests, and never force-pushes.
Repository URLs match case-insensitively. Workspace and Git downloads share the existing size limits.

## Stored proposal

Proposal content is separate from provider state:

```text
projects/<project-id>/notebooks/<notebook-id>/proposals/<proposal-id>/
  proposal.json       immutable manifest, provenance, and content hashes
  changes/<index>      temporary changed file bytes
  publication.json    CAS-managed publication result

_system/proposal-payloads/<project-id>/<notebook-id>/<proposal-id>.json
  immutable expiry marker for the temporary change bytes
```

The manifest stores the selected capture strategy and one or more `add`, `modify`, and `delete`
changes. `publication.json` is the only mutable record and makes completed publication retries
cheap.

For an updated change request, the root proposal's publication is also the CAS-managed pointer to
the latest marimohub-published head commit. Each child proposal retains its own provider result.
The service writes the child result before advancing the root, so a failed publication write can
retry against the provider's previous expected head. A completed replay can repair a missed root
advance without another provider call, while an unavailable repair never withholds the child's
already-recorded result.

Capture creates `proposal.json`, each change object, and the initial publication state with
create-if-absent writes. `proposal.json` is the atomic claim for an idempotency key. A concurrent
loser reuses that manifest only when its session, author, source version, and content hash match.
Interrupted captures leave their immutable objects for a matching retry to complete; they never
delete or overwrite objects that another attempt may own.

Change bytes expire 24 hours after capture. An expired pending proposal rejects capture and
publication with `PROPOSAL_RETRY_REQUIRED`. The same response protects a proposal whose provider
branch no longer has the captured base parent and content tree. The maintenance sweep waits one
additional hour for in-flight requests, then deletes only `changes/<index>` and its expiry marker.
It retains `proposal.json` and `publication.json` as audit metadata.

## V1 boundaries

V1 exposes only the combined capture-and-publish endpoint. It does not expose proposal list,
detail, discard, or patch-download endpoints, so a deployment without a configured publisher
cannot use proposal storage independently. Those APIs are deferred rather than implied by the
stored format.

The required idempotency key protects retries of one operation. The web client reuses its key
after transient failures. It uses a new key after success and when the server returns
`PROPOSAL_RETRY_REQUIRED`. The provider branch is stable for that proposal. Choosing Update creates
a new proposal that targets the displayed change request; choosing Create new omits the target and
replaces the displayed link without closing or deleting the old provider change request. A later
operation with a new key creates another proposal even when the sandbox content is unchanged. Content-level
deduplication needs an atomic object-store uniqueness claim; scanning proposal manifests would
still race under concurrent requests and is not used as a substitute.

The combined endpoint requires a project manager. A future standalone capture endpoint can permit
editors to save proposals while retaining manager approval for publication. Provider commits use
the configured provider identity as committer and include the authenticated marimohub user in a
`Co-authored-by` trailer. The proposal manifest and audit event retain the user's stable marimohub
identity.

## Extension path

Provider support lives behind `SourceControlPublisher`; the API and proposal service do not import
concrete adapters. The port has a required create operation and an optional update operation. A
new provider adds an adapter and registers it in the configuration composition root. The provider
owns authentication and API-specific branch and change-request operations, while the proposal
format and authorization remain unchanged.
See the [provider extension checklist](architecture.md#39-source-control) for the exhaustive configuration and UI mappings.

Additional capture strategies are capture-policy extensions, not provider rewrites. They must emit
the same bounded, immutable change model and define how they identify generated or runtime files.

## Working-branch publication

`WorkingBranchService` coordinates the optional `SourceControlPublisher.workingBranches`
port. Config advertises it only when the provider supports Git workspace reads and
branch writes. The [deployment opt-in](../docs/configuration.md#working-branches)
grants editors this workflow. Legacy proposals remain manager-only and reject working notebooks.

Creation pins the notebook ID, generated branch, and fork SHA before the remote write.
An unexplained existing ref cannot be adopted. After an ambiguous response, creation
resumes only after inspection of the pinned ref. If that ref is absent, a retry repeats
create-if-absent with the same branch name and fork commit. The same idempotency key
resumes notebook and catalog publication.

### Save protocol

The branch CAS lease serializes saves, manual sync, and PR creation. Its update
callback checks lease ownership on every write. `active_save` prevents unrelated
operations from advancing the source while a save remains incomplete.

1. Persist the receipt before publishing its ID in the branch head.
2. Capture source bytes once, with paths, operations, sizes, and SHA-256 hashes.
3. Validate the resulting workspace against import limits, then prepare provider objects and persist the commit SHA.
4. Persist the dispatch marker, then advance the exact expected head without force.
5. Import the exact commit through `SyncedNotebookService`, then acknowledge the session baseline.

GitHub uses `beforeOid` for its conditional ref update. After dispatch, retries first
inspect whether the branch contains the prepared SHA. If it does, import that commit.
If the head still equals the recorded base and publication remains active, retry the same conditional update.
Do not prepare another commit or recapture files.
A null `updateRefs` result with only `UNPROCESSABLE`, `FORBIDDEN`, or `NOT_FOUND` errors
at that mutation is a definite rejection of that request.
On the first dispatch, a definite rejection finishes the save as terminal `conflict`.
After an ambiguous dispatch, a rejected retry cannot rule out that the original request still completes.
The fence therefore holds for `WORKING_BRANCH_DISPATCH_BOUND_MS` (15 minutes) after `dispatched_at`.
Each retried update that is not definitely rejected resets `dispatched_at`.
After the bound, `beforeOid` lets an in-flight update land only through an ABA reset of the head.
A retry then finishes the save as terminal `conflict` when the head moved without the commit,
publication ended, or GitHub definitely rejects the retried update.
Mixed, untyped, malformed, and transport errors retain the dispatch fence.
GitHub documents [atomic ref updates](https://docs.github.com/en/graphql/reference/git#updaterefs).

Current authorization and repository policy apply before remote mutations and hub sync.
Creation replay authorizes the current notebook metadata before returning it, including through MCP.

Capture discovers tracked and untracked paths through Git, then compares live bytes
against the immutable bucket version. Descriptor-relative reads reject symlinks and
special files. Capture never rewrites live HEAD or the index. Later edits remain
available for the next save. Baseline files use the workspace read limit; only changed
bytes count toward the capture limit. Before dispatch, baseline object sizes and captured
changes determine the resulting file count and total size. Oversized results retain their
captures as terminal conflicts, so corrected saves can proceed.

Capture compares the live tree with the version's
[`workspace-manifest.json`](bucket_spec.md#311-local-and-git-workspaces) in bounded batches,
then reads only changed payloads. Unchanged files require no bucket body reads.
Versions without a manifest fall back to reading baseline bytes when sizes match.
Each hash command has a 60-second timeout.
Batches contain at most 256 paths and 32,000 bytes of path arguments.
Capture renews the branch lease between operations when 30 seconds have elapsed.
A lost lease stops publication. A payload that changes after hashing fails capture.

A single stage table drives save handlers, transition ordering, expiry, and cleanup.
An ambiguous dispatch returns immediately; a later request enters the verification handler.
Retry loads the current receipt under the lease and does not construct a synthetic save request.
A transient hub import failure keeps the save at `remote_committed` for a later retry.
A `ValidationError`, `BadRequestError`, or `ForbiddenError` from the import finishes the save as `conflict`.
A hub source that advanced past the save's base also finishes it as `conflict`.
A failed caller authorization check does not end the save.

A failed capture releases admission with a terminal receipt. A new save can retire an abandoned
`claimed` receipt without a capture after acquiring the branch lease. An existing immutable capture must be resumed.
Status serves the remote head and PR cached in the branch record until the cache expires.
Concurrent refreshes share one provider read per service instance. Save admission invalidates the cache;
publication and PR mutations always inspect the provider directly.

`source_version_id` preserves launch provenance. `working_branch_version_id` records
the last acknowledged save and supplies the next capture baseline. Active sessions
protect both versions from pruning. An incomplete save also protects its baseline
after session teardown.

### PR lifecycle and maintenance

PR creation does not capture edits. It requires no active save and a remote head equal to
the hub commit. It reuses the branch association after a lost response.
GitHub searches the head branch across all PR bases.
An observed `ended_reason` permanently blocks new publication, even after the PR reopens or the ref returns.

The [bucket contract](bucket_spec.md#working-branches) defines record ownership,
retention, and cleanup. Explicit retries require current authorization.
Non-authors can finish only stages from `remote_committed` on.
Earlier stages read the author's sandbox or write the branch for the author.
The [user guide](../docs/syncing.md#recovery) states the retry, read, and retention rules.

`working_branch.save` events contain operation IDs, stages, commit IDs, and file counts.
Sync failures emit `working_branch.sync_pending`. Logs exclude source bytes and provider credentials.
Periodic checkpoints and commit-on-end remain deferred.
