---
description: Sync read-only notebooks into marimohub from external Git repositories.
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

Each successful sync creates an immutable version of the repository files under
`root_path`. Each session starts with a fresh copy of the latest version. Optional
[source-control publishing](configuration.md#source-control-publishing) can send
session edits to the provider without changing these stored versions.
With the GitHub App configured, managers can also publish a branch or commit as a
[notebook preview](notebook-previews.md) without changing the synced versions.

GitHub, GitLab, and Azure DevOps Services support pull sources, **Sync now**, and draft change requests.
Each provider uses separate server credentials and [repository policies](#repository-project-policies).
A deployment can configure multiple providers.

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

Git data larger than 25 MB is rejected. Use push mode for a repository that
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

The drift response includes `current_commit`, `remote_commit`, `in_sync`,
`pending_config`, and `checked_at`. The request resolves the branch head each
time and does not change notebook state. Pending source settings always set
`in_sync` to `false`.

The sync endpoint reads the repository tree at the resolved commit. It applies
the push-sync file-count and size limits to files under `root_path`. Files
outside `root_path` do not count against these limits. A pull source's Git
directory still covers the whole repository at that commit, so the 25 MB Git
data limit applies to the full tree. A large monorepo can exceed it even when
its `root_path` is small.

Server sync omits symlinks and other special entries from the workspace. For a
pull source, proposal capture also ignores these omitted Git index entries.

GitHub archive downloads also have limits of 100 MB compressed and 2 GB uncompressed.
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

A pull-mode version always includes `.git`. Publishing can therefore capture
added, modified, and deleted files across the working tree. A push-mode server
sync stores repository files only. Include `.git` in CI archives when a push
source needs multi-file capture.

## Push an archive

Use push sync for providers without a configured reader, or when CI must control sync.
Push sources can also use **Sync now** when their provider supports it.

Upload the tree under `root_path` as the request body. Authenticate with the
sync token and describe the commit via headers:

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

`X-Marimohub-Repo` / `-Branch` / `-Root-Path` re-state the notebook's
configuration so a misrouted workflow can't push to the wrong notebook; a
mismatch is rejected with `400`. `X-Marimohub-Repo` may state the repo as its
bare path even when the notebook stores a full URL — `$GITHUB_REPOSITORY` and
`$CI_PROJECT_PATH` work as-is. The response names every mismatched header and
includes its received and expected values, for example:

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

Symlinks and other non-regular entries are skipped. Archives are size-capped;
oversized or malformed archives are rejected with `400`.

Producing the archive is a one-liner in CI — for example:

```bash
git archive --format=tar.gz -o sync.tgz HEAD:apps   # tree under apps/
```

### Include `.git` for multi-file publishing

`git archive` excludes `.git`. This is sufficient for sync, but publishing then
captures only the configured entry notebook.

For multi-file capture, upload the repository root with its `.git` directory.
marimohub uses Git to find added, modified, deleted, and untracked files. It
honors `.gitignore` and excludes runtime and cache paths.

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
- Keep the archive within 1,000 files, 25 MB per file, and 100 MB decompressed.
  Files inside `.git` count toward these limits.

marimohub stores `.git` with the immutable version and restores it into each
session workspace. If `.git` is absent or the `git` binary is unavailable,
capture uses the entry-notebook fallback. If Git cannot resolve
`X-Marimohub-Commit`, publishing fails without falling back.

### Idempotency

Git commit SHAs are content-addressed, so re-pushing the **same commit** is a
no-op — safe to retry. Pushing a **new commit** cuts a new immutable version and
advances the notebook. A push matching pending settings always creates and
promotes a version, even if its SHA matches the version from the previous source
configuration.

## GitHub Actions example

```yaml
name: Sync notebook to marimohub
on:
  push:
    branches: [main]

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Archive the app subtree
        run: git archive --format=tar.gz -o sync.tgz "HEAD:apps"
      - name: Push to marimohub
        env:
          SYNC_URL: ${{ secrets.MARIMOHUB_SYNC_URL }}
          SYNC_TOKEN: ${{ secrets.MARIMOHUB_SYNC_TOKEN }}
        run: |
          curl --fail-with-body -X POST "$SYNC_URL" \
            -H "Authorization: Bearer $SYNC_TOKEN" \
            -H "Content-Type: application/gzip" \
            -H "X-Marimohub-Archive-Format: tar.gz" \
            -H "X-Marimohub-Repo: ${{ github.repository }}" \
            -H "X-Marimohub-Branch: main" \
            -H "X-Marimohub-Root-Path: apps" \
            -H "X-Marimohub-Commit: ${{ github.sha }}" \
            --data-binary @sync.tgz
```

## GitLab CI example

```yaml
sync-notebook:
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
  script:
    - git archive --format=tar.gz -o sync.tgz "HEAD:apps"
    - |
      curl --fail-with-body -X POST "$MARIMOHUB_SYNC_URL" \
        -H "Authorization: Bearer $MARIMOHUB_SYNC_TOKEN" \
        -H "Content-Type: application/gzip" \
        -H "X-Marimohub-Archive-Format: tar.gz" \
        -H "X-Marimohub-Repo: $CI_PROJECT_PATH" \
        -H "X-Marimohub-Branch: main" \
        -H "X-Marimohub-Root-Path: apps" \
        -H "X-Marimohub-Commit: $CI_COMMIT_SHA" \
        --data-binary @sync.tgz
```

## Rotating the sync token

If a token leaks, rotate it. The old token stops working immediately.
This operation requires project manager access or higher.

```http
POST /api/v1/projects/{pid}/notebooks/{nid}/sync-token/rotate
```

Returns a fresh `sync_url` + `sync_token`.

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
that version. The sandbox is discarded on teardown. Users can publish edits
before teardown, but publishing does not create a marimohub version. A session
cannot start before the first successful sync (`400` otherwise).

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
and 10 MB of added or modified content.

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
