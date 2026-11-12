---
description: Sync Git notebooks into marimohub and save edits to working branches.
---

# Syncing from external sources

> **Status: work in progress.** Synced sources are usable but evolving. The
> request/response shapes documented here are not yet stable, and there is no
> backwards-compatibility guarantee between releases.

marimohub can serve a notebook whose source of truth is an external **Git
repository**. Choose a source mode when you create the notebook:

| Mode   | Primary sync path               | Credential                                             | Supported path   | Git metadata                    |
| ------ | ------------------------------- | ------------------------------------------------------ | ---------------- | ------------------------------- |
| `push` | CI upload or **Sync now**       | Sync token (uploads), provider identity (**Sync now**) | Root or subtree  | Only when the upload has `.git` |
| `pull` | Create request and **Sync now** | Provider identity                                      | Any subdirectory | Included in every version       |

The source mode cannot change after creation. For a push source, **Sync now**
updates the files but does not add Git metadata to the version.

Syncing a new commit creates an immutable version of the files under `root_path`.
New sessions use the latest version. Repeating a sync for the same commit is a
[no-op](#idempotency). Optional
[source-control publishing](configuration.md#source-control-publishing) can send
session edits to a separate proposal branch. Working notebooks also support explicit
saves that update their own stored versions.
With a GitHub App connection, managers can also create a [notebook preview](notebook-previews.md)
from a branch or commit. Previews do not change the synced version.

GitHub, GitLab, and Azure DevOps Services support pull sources, **Sync now**, and draft change requests.
Each provider uses separate server credentials and [repository policies](#repository-project-policies).
A deployment can configure multiple providers.

## Choose a CI workflow

| Goal                     | Tool                                                            | Code source                                      | Hub credential                  |
| ------------------------ | --------------------------------------------------------------- | ------------------------------------------------ | ------------------------------- |
| Preview a pull request   | [`actions/preview`](notebook-previews.md#automatic-pr-previews) | Hub fetches the PR commit through its GitHub App | API token with `preview.manage` |
| Sync a configured branch | [`mohub notebooks source sync`](#sync-now)                      | Hub fetches the notebook's configured branch     | API token with `notebook.write` |
| Publish a checkout       | [`mohub notebooks push`](#push-with-the-cli)                    | Runner uploads local files                       | Notebook sync token             |

[setup-marimohub-cli](https://github.com/marimo-team/setup-marimohub-cli) installs
`mohub` for either CLI command. The preview action calls the Hub directly and
needs neither the CLI nor a checkout.

A typical repository uses two workflows: previews on PR events, then sync on
pushes to `main`. Merging retires the PR previews. The sync workflow updates the
notebook to the merged commit.

Both workflows can target the same notebooks across projects. Preview `targets`
contains project/notebook pairs. The [push manifest](#several-apps-in-one-repository)
also specifies local folders and a sync-token name for each notebook.
API tokens and sync tokens are not interchangeable.

## Local Git identity

Set `MARIMOHUB_GIT_SANDBOX_IDENTITY=user` to use the hub profile name and email
for local commits in new edit sessions. The default, `none`, leaves Git identity
unchanged. App and job sessions do not receive this identity.

This attribution is editable metadata, not a signature or GitHub authorization.
Published commits expose the name and email. Shared editors and agents use the session creator's identity.
Server-created proposal commits have separate attribution. After a configuration change, restart edit sessions.

## Working notebooks

Working notebooks use dedicated GitHub branches. They require the
[working-branch opt-in](configuration.md#working-branches) and a GitHub App.
If the opt-in is set without a GitHub App, startup fails with a configuration error.

> **Warning:** Set a [repository policy](#repository-project-policies) before you enable working branches.
> Without `MARIMOHUB_SOURCE_CONTROL_GITHUB_ALLOWED_REPOSITORIES`, App mode lets any editor write to every installed repository.
> Startup logs a warning for this configuration. Personal mode also requires the connected user's GitHub access.

Editors use **New working branch** in the project creation menu. Managers select
this workflow in the **Sync from git repo** dialog.

1. Choose a repository, base branch, folder, and existing notebook file.
2. Start an edit session.
3. Select **Save to branch** to capture and commit source changes.
4. Select **Open PR** to create a draft PR against the base branch.
5. Continue editing and saving to update the same PR.

The server pins the base commit and creates `marimohub/{project-id}/{notebook-id}`.
Each successful save updates the stored version and the next capture baseline.
The live files, Git index, and Git HEAD stay unchanged. New sessions use the latest
synchronized commit.

**Save before you stop a session.** Session termination does not preserve uncaptured edits.
Captures include local commits, staged edits, and eligible untracked files under the
notebook folder. `.gitignore` applies to new files. Captures exclude Git metadata,
environment and cache directories, and marimo runtime state.

Captures allow at most 1,000 changed files, 2,000 candidate paths, and 10 MiB of changed content.
Unchanged imported files do not count toward the content limit. Before publication,
the resulting workspace must fit the import limits: 1,000 files, 25 MiB per file, and 100 MiB total.
Symlinks, special files, and deletion of the entry notebook are rejected.
Working notebooks cannot change source configuration or move between projects.
Deleting a notebook leaves its remote branch and PR intact.

### Recovery

A save records its stage in a receipt. While a save is unfinished, the notebook
blocks new saves, **Sync now**, and **Open PR** for every editor. Select **Retry save**
to continue the save. A retry reuses the stored capture and commit.

| Save result                                      | Action                                                                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Commit succeeded, hub sync pending               | Select **Retry save** to import the exact commit without another capture.                                        |
| Remote outcome unknown                           | Select **Retry save**. If the head still matches the recorded base, the hub retries the same conditional update. |
| Branch moved, or GitHub rejects a retried update | Wait 15 minutes, then select **Retry save**. The save finishes as `conflict` and releases the notebook.          |
| Commit succeeded, hub import rejected            | The save finishes as `conflict`. Fix the cause, then use [**Sync now**](#sync-now) to import the commit.         |

The 15-minute bound starts when the hub sends the branch update to GitHub.
Each retried update restarts the bound, unless GitHub definitely rejects it.
Before the bound, a retry that cannot confirm the commit keeps the save pending,
because an earlier update can still arrive.

Some saves finish as `conflict` before the remote update and release the notebook at once.
Causes include a failed capture, a moved branch, a workspace-limit violation, and a tree conflict.
A definite rejection of the first remote update has the same result.
Correct the files or repository rules, then start a new save.

The save author can retry any stage. Other editors can retry only `remote_committed`
and `hub_synced` saves, because their commit is already on GitHub.
A captured save can resume after its session ends.

A recovery ZIP contains the captured files and a manifest of all changes, including deletions.
Only the save author and project managers can read a save receipt or download its recovery ZIP.
To keep work from a `conflict` save, download the ZIP and apply the files in a new save.

A save that has not sent its remote update expires 24 hours after it starts.
Captures of saves in `ref_dispatched`, `remote_committed`, or `hub_synced` stay until
the save finishes. Maintenance can delete other captures 25 hours after the save starts.
A dispatched save that finishes after this time can lose its capture on the next maintenance pass.
Download recovery before you retry a save that is past the 15-minute bound.
Maintenance never publishes captures.

A closed, merged, or retargeted PR ends publication. An observed branch deletion also
ends publication, even if someone recreates the branch. These cases require a new
working notebook. The hub never force-pushes, merges, or rebases.

### API and tools

Create through `POST /api/v1/projects/{pid}/notebooks/git` with
`"fork": {"base_branch": "main"}` and an `Idempotency-Key` header.
The other routes share the prefix `/api/v1/projects/{pid}/notebooks/{nid}`:

| Operation     | Route                                          | `Idempotency-Key` |
| ------------- | ---------------------------------------------- | ----------------- |
| Save          | `POST /sessions/{sid}/working-branch/saves`    | Required          |
| Branch status | `GET /working-branch`                          | —                 |
| Save receipt  | `GET /working-branch/saves/{save_id}`          | —                 |
| Retry         | `POST /working-branch/saves/{save_id}/retry`   | —                 |
| Recovery ZIP  | `GET /working-branch/saves/{save_id}/recovery` | —                 |
| Open PR       | `POST /working-branch/change-request` (`201`)  | Required          |

Use a separate key for each operation. After a timeout, reuse the same key.
The generated OpenAPI schema defines complete requests and responses.
The [MCP working-branch tools](./mcp.md#working-branches) and project chat expose the
same operations, with separate consent for remote writes.
Branch status is cached for one minute. The web refreshes on focus and after mutations, without timer polling.

## How it works

```
┌─────────────┐   CI archive + token   ┌──────────────────┐
│ your repo   │ ─────────────────────▶ │ POST {sync_url}  │ ──┐
│             │   Provider pull        ├──────────────────┤   │
│  (Git)      │ ─────────────────────▶ │ source/sync API  │ ──┤
└─────────────┘                        └──────────────────┘   │
                                                           ▼
                                                ┌─────────────────────┐
                                                │ bounded ingest      │
                                                │ immutable version   │
                                                │ CAS source pointer  │
                                                └─────────────────────┘
```

Each sync writes the repository files into a fresh
`versions/{vid}/workspace/` mirror. It then uses compare-and-swap to advance the
notebook's source pointer. Concurrent syncs cannot combine files from different
versions. The source pointer always references one complete version.

Each synced version stores a best-effort packed copy of the final workspace for
sandbox startup. Pull-mode archives include the credential-free Git directory
under `.git/`. Startup transfers and extracts this single object when available.
If the object is absent or extraction fails, provisioning restores the canonical
per-file objects. Packing is limited to 32 MiB of combined workspace and Git
input, and Git object files are stored without recompression.

Provisioning counters describe the transferred representation. A packed restore
reports `files_objects=1` and compressed archive bytes in `files_bytes`; a
canonical restore reports its individual object count and stored byte total. The
`files_archive_used`, `files_archive_missing`, and `files_archive_failed`
counters identify the selected path.

## Create a synced notebook

```http
POST /api/v1/projects/{pid}/notebooks/git
Content-Type: application/json

{
  "title": "Sales dashboard",
  "description": "Synced from the analytics repo",
  "provider": "github",
  "repo": "acme/analytics",
  "branch": "main",
  "root_path": "apps",
  "entry_notebook": "dashboard.py",
  "sync_mode": "push"
}
```

| Field            | Required | Notes                                                                                                        |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `provider`       | no       | `github`, `gitlab`, or `azure-devops`. Usually derived from `repo`.                                          |
| `repo`           | yes      | Repository URL or `owner/name`. Pull mode supports configured GitHub, GitLab, and Azure DevOps repositories. |
| `branch`         | yes      | Branch this notebook tracks.                                                                                 |
| `root_path`      | no       | Repo subdirectory whose tree is mirrored. Defaults to the repo root (`""`).                                  |
| `entry_notebook` | yes      | The notebook to open (`.py`, `.md`, `.markdown`, or `.qmd`), **relative to `root_path`**.                    |
| `sync_mode`      | no       | `push` (default) or `pull`. Pull mode requires a configured provider.                                        |

`repo` accepts `owner/repo` or a repository URL. The shorthand refers to GitHub,
unless `provider` is `gitlab`. GitLab URLs can contain nested groups, such as
`https://gitlab.example.com/group/subgroup/project`. marimohub converts
scheme-less and SSH remotes to HTTPS when it stores them.

marimohub derives `provider` from configured repository hosts or the host name. Set it only when a
custom host does not identify the provider. The value controls provider links
in the web interface. If neither the host nor `provider` identifies a provider,
the interface shows the sync metadata without links.

For push mode, the response returns the notebook plus its sync credentials:

```json
{
  "success": true,
  "data": {
    "notebook": { "id": "nb_…", "status": "draft", … },
    "sync_url": "https://your-host/api/sync/git/v1/projects/{pid}/notebooks/{nid}",
    "sync_token": "mhsync_…"
  }
}
```

The `sync_token` is shown **once**. Store it as a CI secret. The server keeps
only a SHA-256 of it.

### Pull mode: connect a repository

<span id="pull-mode-connect-a-github-repository"></span>

Use pull mode when marimohub must sync the repository. Set `sync_mode` to
`pull`:

```json
{
	"title": "Sales dashboard",
	"description": "Connected to the analytics repo",
	"repo": "acme/analytics",
	"branch": "main",
	"root_path": "python",
	"entry_notebook": "apps/dashboard.py",
	"sync_mode": "pull"
}
```

The deployment must list the repository provider in `source_control.pull_source_providers`
from `GET /api/v1/capabilities`. Configure a [GitHub App](configuration.md#github-app), [GitLab token](#gitlab), or
[Azure DevOps identity](#azure-devops-services) first. The create request reads the branch head before
it returns. On success, the response contains an active notebook without
`sync_url` or `sync_token`.

If the first pull fails, the response contains a draft notebook and
`sync_error`. Correct the repository coordinates or provider access. Then use
**Sync now** to retry.

`root_path` selects the subtree to mirror, such as the `python/` directory of a
monorepo. The workspace contains only that subtree, and `entry_notebook` is
relative to it. Leave it empty to mirror the whole repository.

Each pull stores a shallow, credential-free Git directory for the exact commit.
marimohub restores this directory into the session workspace. With a
`root_path`, `.git` sits above the workspace and the session runs from the
subtree under a sparse checkout, so `git status` reports only changes inside
it. The sparse checkout is best-effort. If it fails, `git status` reports the
rest of the repository as deleted. Proposals still contain only changes inside
the subtree, because capture runs with `--relative`. Session startup fails if
the Git directory cannot be restored completely.
Provider credentials stay on the server.

Git data larger than 25 MiB is rejected. Use push mode for a repository that
exceeds this limit. The stored `.git` covers the whole repository, not only
`root_path`. Large monorepos, the main use of `root_path`, can exceed this
limit.

## GitLab

Use a full HTTPS URL, including any nested groups: `https://gitlab.com/group/subgroup/project`.

1. Create a project or group access token with the `api` and `write_repository` scopes, for an identity with **Developer** access that can push proposal branches.
   A personal access token also works, but its `api` scope reaches every project its user can access.
2. Set the token and [repository policy](#repository-project-policies) on the Hub server:

   ```bash
   MARIMOHUB_SOURCE_CONTROL_GITLAB_TOKEN=<access-token>
   MARIMOHUB_SOURCE_CONTROL_GITLAB_ALLOWED_REPOSITORIES='[{"resource":"https://gitlab.com/team/notebooks","projects":["proj-0000000000000000"]}]'
   ```

3. For self-managed GitLab, set `MARIMOHUB_SOURCE_CONTROL_GITLAB_SERVER_URL=https://code.example.com`.
   The default is `https://gitlab.com`. The value accepts an HTTPS origin and optional port, without a URL path.
   Repository URLs must use this origin.
4. Restart Hub.
5. Open **Add a git repository** and enter the repository URL, branch, folder, and notebook file.

The server needs access to the GitLab API and HTTPS Git endpoints.
For a private CA, set `NODE_EXTRA_CA_CERTS` before you start Node.

GitLab publication downloads a shallow Git snapshot, so [pull limits](#pull-mode-connect-a-repository) apply to the whole repository.
Webhooks and notebook previews are not supported. [CI uploads](#gitlab-ci-example) remain available.
See GitLab's [access token scopes](https://docs.gitlab.com/security/tokens/access_token_scopes/).

## Azure DevOps Services

Use the hosted HTTPS URL, `https://dev.azure.com/organization/project/_git/repository`,
or the portal clone URL, `https://organization@dev.azure.com/organization/project/_git/repository`.
This adapter supports hosted Azure DevOps Services only.
Azure DevOps Server, `visualstudio.com` URLs, SSH remotes, PATs, webhooks, and notebook previews are not supported.

1. Add a Microsoft Entra service principal or managed identity to your Azure DevOps organization.
2. Grant repository **Read**, **Contribute**, **Create branch**, and **Contribute to pull requests** permissions.
3. Set the organization and [repository policy](#repository-project-policies) on the Hub server:

   ```bash
   MARIMOHUB_SOURCE_CONTROL_AZURE_DEVOPS_ORGANIZATION=acme
   MARIMOHUB_SOURCE_CONTROL_AZURE_DEVOPS_ALLOWED_REPOSITORIES='[{"resource":"https://dev.azure.com/acme/analytics/_git/notebooks","projects":["proj-0000000000000000"]}]'
   ```

4. For client-secret authentication, set all three variables:

   ```bash
   MARIMOHUB_SOURCE_CONTROL_AZURE_DEVOPS_TENANT_ID=<tenant-id>
   MARIMOHUB_SOURCE_CONTROL_AZURE_DEVOPS_CLIENT_ID=<application-client-id>
   MARIMOHUB_SOURCE_CONTROL_AZURE_DEVOPS_CLIENT_SECRET=<client-secret>
   ```

   Otherwise, omit all three to use `DefaultAzureCredential`, including managed identity, workload identity, or local Azure CLI credentials.
   It reads the same `AZURE_*` environment as Azure storage and object browsing, so they share one identity.

5. Restart Hub and open **Add a git repository**.
6. Select the connection option and enter the repository URL, branch, folder, and notebook file.

[Pull-mode behavior](#pull-mode-connect-a-repository) and [server-sync limits](#sync-now) apply to Azure DevOps.

See Microsoft's [identity setup guide](https://learn.microsoft.com/en-us/azure/devops/integrate/get-started/authentication/service-principal-managed-identity?view=azure-devops).

## View or edit sync settings

In the project list, open the notebook's actions menu and choose **Sync
settings**. It shows the repository, branch, repository folder, entry notebook,
and last successful sync. Push sources also show the sync URL and token
controls. Project editors can change the four source coordinates:

```http
PATCH /api/v1/projects/{pid}/notebooks/{nid}/source
Content-Type: application/json

{
  "repo": "acme/analytics",
  "branch": "release",
  "root_path": "notebooks",
  "entry_notebook": "dashboard.py"
}
```

For an existing custom-host source, a bare `owner/repo` continues to use that
host. GitHub.com shorthand remains bare.

The source mode cannot change. A pull source must continue to use a repository supported by a configured provider. marimohub rejects unsupported source changes before it
stores them.

Before the first successful sync, changes take effect immediately. After that,
changes remain pending until a CI upload or server sync matches the new source
coordinates. The notebook continues to serve its last successful version in
the meantime. Editing the source does not change the sync URL or rotate its
token. Pull sources promote pending settings on the next **Sync now**. Push
sources promote them on a matching CI upload or server sync.

## Sync now

<span id="sync-now-with-github"></span>

**Sync now** reads a repository branch through the configured provider. Pull sources use this
action as their normal sync method. Push sources can use it as an alternative to
a CI upload.

The notebook's provider must appear in `source_control.sync_providers` from
`GET /api/v1/capabilities`. The server derives this list from configured readers.

The API provides these endpoints:

| Endpoint                                                  | Result                                                                        |
| --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `GET /api/v1/projects/{pid}/notebooks/{nid}/source/drift` | Resolves the current branch head and compares it with the last synced commit. |
| `POST /api/v1/projects/{pid}/notebooks/{nid}/source/sync` | Downloads the branch head and creates a version when the commit has changed.  |

Both endpoints require the project **editor** role or a higher role. They use
the repository, branch, and root path from the notebook's source settings. A
caller cannot supply different source coordinates.

To sync from CI, set `MARIMOHUB_URL` and an API token in `MARIMOHUB_TOKEN`, then run:

```bash
mohub notebooks source sync --pid "$PROJECT_ID" --nid "$NOTEBOOK_ID" --yes
```

This command does not need a checkout. The Hub reads the configured branch
through its provider connection.

The drift response includes `current_commit`, `remote_commit`, `in_sync`,
`pending_config`, and `checked_at`. The request resolves the branch head each
time and does not change notebook state. Pending source settings always set
`in_sync` to `false`.

The sync endpoint reads the repository tree at the resolved commit. It applies
the push-sync file-count and size limits to files under `root_path`. Files
outside `root_path` do not count against these limits. A pull source's Git
directory still covers the whole repository at that commit, so the 25 MiB Git
data limit applies to the full tree. A large monorepo can exceed it even when
its `root_path` is small.

Server sync omits symlinks and other special entries from the workspace. For a
pull source, proposal capture also ignores these omitted Git index entries.

GitHub archive downloads also have limits of 100 MiB compressed and 2 GiB uncompressed.
If no settings are pending and the notebook already points to the commit, the
endpoint returns `synced: false` and creates no version. A sync against pending
source settings makes those settings active. The response includes the resolved
`commit` and the new `version_id`. For a no-op, `version_id` is `null`.

The web interface shows drift status and **Sync now** in **Sync settings**. On
the notebook page, it also shows them in the **Git source details** dialog. Open
that dialog from the branch badge or the notebook menu. In the project list, the
repository popover shows them too. The action is available to editors when the
provider supports server sync.

CI uploads and **Sync now** share commit-based idempotency. If one method already
synced a commit, the other method does not create a duplicate version.

A pull-mode version includes `.git`, so [proposals](#publishing-edits-back-to-the-repository)
can capture added, modified, and deleted workspace files. A push-mode server
sync stores repository files only. Include `.git` in CI archives when a push
source needs to send multi-file edits back to Git.

## Push with the CLI

Set `MARIMOHUB_URL` and `MARIMOHUB_SYNC_TOKEN` in the job environment, then run:

```bash
mohub notebooks push --pid proj-… --nid nb-… --root-path apps
```

`--root-path` selects a folder relative to the repository root. The command
packs its working tree. `--repo`, `--branch`, and `--commit` override Git metadata.
Missing values fall back to GitHub or GitLab CI variables.

Use `--dry-run` to list files and source headers without credentials or an upload.
Successful uploads print `version_id` and `synced`. An unchanged commit returns
`version_id: null` and `synced: false`. Errors include the server message and exit nonzero.
Commit local changes before uploading. [Repeated SHAs do not create versions](#idempotency).

Archives default to `tar.gz`. Use `--format zip` for ZIP.
`.marimohubignore` uses Git ignore patterns, including negation. `.gitignore` does
not apply. Exclude secrets and build output explicitly: hidden files are included.
The CLI excludes `.git` and rejects symlinks and special files.

Limits are 1,000 files, 25 MiB per file, and 100 MiB total.
To [send multi-file edits back to Git](#include-git-for-multi-file-publishing), use `--include-git`
with an empty `root-path` and a shallow checkout without stored credentials.
Linked worktrees are unsupported.

### Several apps in one repository

Create an `apps.json` manifest with 1–256 notebooks across projects.
Each entry specifies a folder, project ID, notebook ID, and sync-token secret name:

```json
[
	{ "path": "apps/sales", "pid": "proj-…", "nid": "nb-…", "secret": "MARIMOHUB_SYNC_SALES" },
	{ "path": "apps/ops", "pid": "proj-…", "nid": "nb-…", "secret": "MARIMOHUB_SYNC_OPS" }
]
```

For CLI runs, export each named secret as an environment variable, then run:

```bash
mohub notebooks push --manifest apps.json --dry-run
mohub notebooks push --manifest apps.json
```

Store secret names, never tokens, in the manifest. Paths are relative to the
repository root. `--repo`, `--branch`, `--commit`, and `--format` apply to all entries.
Bulk uploads exclude `.git`.

The CLI checks all entries before uploading and rejects duplicate targets or
missing tokens. Uploads run sequentially and continue after individual server errors.
Results identify each project, notebook, version, and error. Any failure exits
nonzero, but completed uploads remain published. Retry the manifest to finish.

## GitHub Actions example

Use [setup-marimohub-cli](https://github.com/marimo-team/setup-marimohub-cli) to
install the CLI, then run `mohub notebooks push`. The same command works locally
and in CI. The example uses `latest`. For production, pin a release that includes `notebooks push`.

```yaml
name: Publish app
on:
  push:
    branches: [main]
permissions:
  contents: read
concurrency:
  group: publish-app-${{ github.repository }}
  cancel-in-progress: false
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: marimo-team/setup-marimohub-cli@15f7152034cdf6728c02be77d39526360ce60ec2 # v1.0.1
        with:
          version: latest
      - run: mohub notebooks push --pid "$PROJECT_ID" --nid "$NOTEBOOK_ID" --root-path apps
        env:
          MARIMOHUB_URL: ${{ vars.MARIMOHUB_URL }}
          MARIMOHUB_SYNC_TOKEN: ${{ secrets.MARIMOHUB_SYNC_TOKEN }}
          PROJECT_ID: ${{ vars.MARIMOHUB_PROJECT_ID }}
          NOTEBOOK_ID: ${{ vars.MARIMOHUB_NOTEBOOK_ID }}
```

### Publish several apps

Use the [bulk manifest](#several-apps-in-one-repository) and replace the push step with:

```yaml
- run: mohub notebooks push --manifest apps.json
  env:
    MARIMOHUB_URL: ${{ vars.MARIMOHUB_URL }}
    MARIMOHUB_SYNC_SALES: ${{ secrets.MARIMOHUB_SYNC_SALES }}
    MARIMOHUB_SYNC_OPS: ${{ secrets.MARIMOHUB_SYNC_OPS }}
```

Pass each secret named in the manifest explicitly. Keep the checkout, setup,
and concurrency configuration from the single-app example. Run on trusted branch pushes.

## GitLab CI example

Install `mohub` on the runner and set `MARIMOHUB_URL`.
Store `MARIMOHUB_SYNC_TOKEN` as a masked, protected CI variable.

```yaml
sync-notebook:
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
  script:
    - mohub notebooks push --pid "$MARIMOHUB_PROJECT_ID" --nid "$MARIMOHUB_NOTEBOOK_ID" --root-path apps
```

## Push an archive

Use push sync for providers without a configured reader, or when CI must control sync.
Push sources can also use **Sync now** when their provider supports it.

The CLI builds this request for you. For a custom client, send the archive as
the request body with a sync token and source headers:

```http
POST {sync_url}
Authorization: Bearer mhsync_…
Content-Type: application/zip
X-Marimohub-Repo: acme/analytics
X-Marimohub-Branch: main
X-Marimohub-Root-Path: apps
X-Marimohub-Commit: 9f2c1ab…

<binary archive bytes>
```

| Header                       | Required | Notes                                                       |
| ---------------------------- | -------- | ----------------------------------------------------------- |
| `Authorization`              | yes      | `Bearer <sync_token>`.                                      |
| `X-Marimohub-Repo`           | yes      | Must name the notebook's `repo` (path form is accepted).    |
| `X-Marimohub-Branch`         | yes      | Must match the notebook's `branch`.                         |
| `X-Marimohub-Root-Path`      | no       | Must match the notebook's `root_path` (defaults to `""`).   |
| `X-Marimohub-Commit`         | yes      | The git commit SHA being pushed.                            |
| `X-Marimohub-Archive-Format` | no       | `zip`, `tar`, or `tar.gz`. Otherwise sniffed from the body. |

The repository, branch, and root-path headers must match the notebook's source
settings. A mismatch returns `400` with the received and expected values.
The repository header accepts a bare path even if the notebook stores a full
URL, so `$GITHUB_REPOSITORY` and `$CI_PROJECT_PATH` work directly:

```json
{
	"success": false,
	"error": {
		"code": "BAD_REQUEST",
		"message": "Sync source mismatch: X-Marimohub-Root-Path received \"other\", expected \"apps\". Update the request headers or the notebook's sync settings."
	}
}
```

The archive paths are **relative to `root_path`**, and `entry_notebook` must be
present in the archive.

### Supported archive formats

- **zip**
- **tar** (POSIX ustar, plus the pax `x`/global `g` headers and GNU long-name
  entries that `git archive` and GitHub codeload emit)
- **tar.gz** (gzip-compressed tar)

The server skips symlinks and other non-regular entries. It rejects oversized
or malformed archives with `400`.

To archive the committed files under `apps/`:

```bash
git archive --format=tar.gz -o sync.tgz HEAD:apps   # tree under apps/
```

<span id="include-git-for-multi-file-publishing"></span>

### Include Git metadata for proposals

Git metadata is not required to sync files or run an app. It is required to
[send multi-file editor changes back to Git](#publishing-edits-back-to-the-repository).
Without `.git`, proposals capture only the configured entry notebook.

Add `--include-git` to the push command to include Git metadata. For a custom
archive, include the repository root and its `.git` directory. During proposal
capture, marimohub honors `.gitignore` and excludes runtime and cache paths.

Archive the complete checkout instead of using `git archive`:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 1
    persist-credentials: false
- name: Archive the repository
  run: tar czf /tmp/sync.tgz .
```

Upload `/tmp/sync.tgz` with the headers from [Push an archive](#push-an-archive).
Omit `X-Marimohub-Root-Path`, or set it to an empty string.

This method has these requirements:

- Set `root_path` to `""`. A repository-level `.git` cannot describe a subtree
  archive.
- Keep the checkout shallow. Full Git history counts toward the archive limits.
- Set `persist-credentials` to `false`. This prevents the workflow token from
  entering the archive through `.git/config`.
- Make sure that the archive contains the commit from `X-Marimohub-Commit`.
- Keep the archive within 1,000 files, 25 MiB per file, and 100 MiB decompressed.
  Files inside `.git` count toward these limits.

marimohub stores `.git` with the immutable version and restores it into each
session workspace. If `.git` is absent or the `git` binary is unavailable,
proposal capture uses the entry-notebook fallback. If Git cannot resolve
`X-Marimohub-Commit`, proposal capture fails.

### Idempotency

Re-pushing the **same commit** is a no-op. Pushing a **new commit** creates an
immutable version and advances the notebook. Commit changes before uploading:
new working-tree bytes with the same SHA do not create a version.

A push that matches pending source settings always creates a version and activates
those settings, even if the previous source used the same SHA.

<span id="without-the-cli"></span>

### Upload with curl

This example uses GitLab CI variables to describe the commit.

```bash
git archive --format=tar.gz -o /tmp/sync.tgz HEAD:apps
curl --fail-with-body -X POST "$MARIMOHUB_SYNC_URL" \
  -H "Authorization: Bearer $MARIMOHUB_SYNC_TOKEN" \
  -H "Content-Type: application/gzip" \
  -H "X-Marimohub-Archive-Format: tar.gz" \
  -H "X-Marimohub-Repo: $CI_PROJECT_PATH" \
  -H "X-Marimohub-Branch: $CI_COMMIT_REF_NAME" \
  -H "X-Marimohub-Root-Path: apps" \
  -H "X-Marimohub-Commit: $CI_COMMIT_SHA" \
  --data-binary @/tmp/sync.tgz
```

## Rotating the sync token

If a token leaks, rotate it. The old token stops working immediately.
This operation requires project manager access or higher.

```http
POST /api/v1/projects/{pid}/notebooks/{nid}/sync-token/rotate
```

Returns a fresh `sync_url` + `sync_token`.

For push sources, rotate the token after a [move to another project](./organizing-projects.md#move-a-notebook-to-another-project),
then update CI with the new `sync_url` and `sync_token`.

## Dependencies

marimohub adds dependencies to the sandbox image environment in this order:

1. Synced root `pyproject.toml` dependencies, through `uv sync --inexact`.
2. Entry notebook [PEP 723](https://peps.python.org/pep-0723/) dependencies,
   through `uv export --script` and `uv pip install`.

Setup failures stop startup with `PYTHON_ENV_SETUP_FAILED`.
Inline pins can replace project versions, so keep requirements compatible.
The image supplies marimo regardless of notebook pins.

Local notebooks follow the same [dependency contract](sandbox-image.md#inline-dependencies),
including Python-version and custom-index limits.

## Read-only sessions

Each session starts from the latest synced version. Session edits do not change
that version. The sandbox is discarded on teardown. Before teardown, users can
send edits to a [proposal branch](#publishing-edits-back-to-the-repository).
The notebook version changes only after a sync. A session cannot start before
the first successful sync (`400` otherwise).

### Publishing edits back to the repository

When [source-control publishing](configuration.md#source-control-publishing) is
configured, a project manager can publish edits from a persistent editor
session. Each publication stores an immutable proposal.
The first publication opens a draft pull request (PR), or a draft merge request (MR) on GitLab.
GitLab actions use **MR** in place of **PR** below.

After the first publication, the editor shows **View PR** and two more actions:

- **Update PR** publishes a new proposal to the same pull request. It adds a
  commit without overwriting external branch changes. GitHub can rebuild the
  proposal branch from the synced base when needed.
- **Create new PR** opens another pull request and replaces the displayed link.
  The previous pull request remains on the provider.

Azure DevOps and GitLab updates restore omitted files from the original base commit.
Updates stop if the proposal branch changes externally, disappears, or its change request closes.
Retries recover completed pushes and change requests after lost responses.
Azure DevOps rejects updates that need a Git file mode change. Use **Create new PR** for those proposals.
After a merge, use **Sync now** to import the merged commit.

The web interface uses this endpoint:

```http
POST /api/v1/projects/{pid}/notebooks/{nid}/sessions/{sid}/change-requests
```

If the synced version [includes `.git`](#include-git-for-multi-file-publishing),
the proposal can contain changes from the full working tree. Otherwise, the
proposal contains only the entry notebook. Each proposal supports 1,000 changes
and 10 MiB of added or modified content.

## GitHub Enterprise Server

A deployment connects to github.com (default) or one GitHub Enterprise Server (GHES) instance.

1. Register a [GitHub App](configuration.md#github-app) on GHES with Contents and Pull requests read/write permissions.
2. Install the App on the repositories marimohub will access.
3. Generate a private key from the App settings.
4. Set these variables on the marimohub server, then restart it:

```bash
MARIMOHUB_SOURCE_CONTROL_GITHUB_SERVER_URL=https://git.acme.corp
MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_ID=123
MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY='<PEM or base64-encoded PEM>'
MARIMOHUB_SOURCE_CONTROL_GITHUB_ALLOWED_REPOSITORIES='[{"resource":"https://git.acme.corp/team/notebooks","projects":["proj-0000000000000000"]}]'
```

`MARIMOHUB_SOURCE_CONTROL_GITHUB_SERVER_URL` is the GHES web origin, not the API URL.
Use full HTTPS URLs for GHES sources and allowlist rules. The configured host
supplies the `github` provider automatically. On creation, `owner/repo` still
means github.com; when editing a source, shorthand keeps its current host.
[Notebook previews](notebook-previews.md) use the same host.

marimohub sends REST requests to `{origin}/api/v3` for any host other than
github.com. GHE.com data-residency tenants are not supported yet.

The server needs HTTPS access to GHES and, with subdomain isolation enabled,
its `codeload.` subdomain. Archive downloads retain their size limits and do
not forward installation tokens to the codeload subdomain.

For an internal CA, mount its PEM certificate chain and set
`NODE_EXTRA_CA_CERTS=/path/to/ca.pem` before starting Node. Keep TLS verification
enabled. The Cloudflare Worker entrypoint usually cannot reach an on-premises
host; use the Node server on a network with access to GHES.

## Repository project policies

<span id="github-project-policies"></span>

::: warning Set a repository policy for each provider
Without a policy, every project can reach every repository the provider credential can access.
A GitHub App installed across an organization or GHES instance, a group or personal GitLab token, or an organization-wide Azure identity exposes all of those repositories.
:::

Each provider has an independent `ALLOWED_REPOSITORIES` policy for its shared credentials:

| Provider     | Variable                                                     | Repository format                                                        |
| ------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| GitHub       | `MARIMOHUB_SOURCE_CONTROL_GITHUB_ALLOWED_REPOSITORIES`       | `owner/repo` for github.com, or a full HTTPS URL for the configured host |
| GitLab       | `MARIMOHUB_SOURCE_CONTROL_GITLAB_ALLOWED_REPOSITORIES`       | Full HTTPS URL on the configured host, including nested groups           |
| Azure DevOps | `MARIMOHUB_SOURCE_CONTROL_AZURE_DEVOPS_ALLOWED_REPOSITORIES` | Full `dev.azure.com` URL in the configured organization                  |

```json
[{ "resource": "https://github.com/team/notebooks", "projects": ["proj-0000000000000000"] }]
```

- `resource` matches a canonical repository URL. Matching ignores case for all providers. `"*"` permits any repository accessible to the provider identity.
- `projects` lists project IDs. `"*"` shares the repository across projects.
- `[]` denies all access. An unset or blank policy permits shared access and emits a startup warning.
- Invalid policies stop startup. Restart Hub to apply changes.

Policies cover branch checks, workspace and Git downloads, preview reads, and the creation and update of pull requests and merge requests.
The provider identity must also have repository access. These policies do not restrict user-supplied credentials.

## Personal GitHub publishing

`MARIMOHUB_SOURCE_CONTROL_GITHUB_PUBLISH_ACTOR` selects the identity for new interactive commits and PRs.
The default, `app`, uses the shared App installation. The `user` value requires the acting user's connected GitHub account and verified commits.
Pull sync, previews, and background jobs retain the App identity.
You can combine either mode with [local Git identity](#local-git-identity).

### Configuration and account connection

1. Configure a [GitHub App](configuration.md#github-app) with Contents and Pull requests read/write permissions.
2. Install the App on the allowed repositories.
3. Set `MARIMOHUB_SOURCE_CONTROL_GITHUB_CLIENT_ID` and `MARIMOHUB_SOURCE_CONTROL_GITHUB_CLIENT_SECRET` from that same App.
4. Set `MARIMOHUB_APP_BASE_URL` to the canonical HTTPS hub origin.
5. Register `<hub-origin>/api/v1/me/github/callback` as the App callback URL.
6. Set `MARIMOHUB_SECRETS_KEK` for encrypted account storage.
7. Set `MARIMOHUB_SOURCE_CONTROL_GITHUB_PUBLISH_ACTOR=user`.
8. Configure [repository project policies](#repository-project-policies).
9. Select **GitHub account → Connect GitHub** from your user menu.

Personal publishing supports github.com. HTTP callbacks work only on loopback development origins.
The user and App both need repository access. Hub roles and repository policies still apply.
Missing access, revoked credentials, or failed verification stop publication. The hub never substitutes App credentials for a personal write.

GitHub creates the commit on a temporary branch. Repository rules must permit these branches.
The hub verifies its SHA, parent, tree, message, account ID, and GitHub signature before it updates the target branch.
A concurrent target change stops publication. Modifications to executable files, symlinks, or unsupported modes fail before blob writes.
Personal commits omit hub coauthor trailers. Local commits, ancestors, and merge commits have no signing guarantee from this configuration.
GitHub labels also depend on vigilant mode and repository policy.

Retries retain their original connection and verification requirement. A replacement connection cannot take over an unfinished operation.
If the original connection is unusable, start a new operation from the saved recovery payload.
See [Security](security.md#personal-github-publishing) for trust boundaries and [Operations](operations.md#personal-github-credentials) for configuration changes and recovery.
