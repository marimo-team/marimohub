---
description: Sync read-only notebooks into marimohub from external Git repositories.
---

# Syncing from external sources

> **Status: work in progress.** Synced sources are usable but evolving. The
> request/response shapes documented here are not yet stable, and there is no
> backwards-compatibility guarantee between releases.

marimohub can serve a notebook whose source of truth lives in an external
**Git repository**. You can update the notebook with either sync method:

- **Push sync** sends an archive from a CI workflow. It uses a notebook-scoped
  sync token and does not give marimohub repository credentials.
- **Server-initiated sync** pulls a configured GitHub branch on demand. It uses
  the server's GitHub App credentials and does not require a CI workflow.

You can use both methods for the same notebook. Each successful sync creates an
immutable version of the repository files under `root_path`. Running sessions
get a fresh copy of the latest version. Optional
[source-control publishing](configuration.md#source-control-publishing) can send
session edits to the provider without changing these stored versions.

## How it works

```
┌─────────────┐   CI archive + token   ┌──────────────────┐
│ your repo   │ ─────────────────────▶ │ POST {sync_url}  │ ──┐
│             │   GitHub App pull      ├──────────────────┤   │
│  (GitHub)   │ ─────────────────────▶ │ source/sync API  │ ──┤
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

## 1. Create a synced notebook

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
  "entry_notebook": "dashboard.py"
}
```

| Field            | Required | Notes                                                                                      |
| ---------------- | -------- | ------------------------------------------------------------------------------------------ |
| `provider`       | no       | `github` or `gitlab`. Usually derived from `repo`; see below.                              |
| `repo`           | yes      | Repository URL or `owner/name`. Server sync pulls from it, and push headers must match it. |
| `branch`         | yes      | Branch this notebook tracks.                                                               |
| `root_path`      | no       | Repo subdirectory whose tree is mirrored. Defaults to the repo root (`""`).                |
| `entry_notebook` | yes      | The notebook to open (`.py`, `.md`, `.markdown`, or `.qmd`), **relative to `root_path`**.  |

`repo` accepts `owner/repo` (GitHub shorthand; gitlab.com when `provider` is
`gitlab`) or a repository URL such as
`https://gitlab.example.com/group/subgroup/project` — nested GitLab groups
included. Scheme-less `host.tld/group/project` and SSH remotes
(`git@host:path.git`) are rewritten to https on write.

`provider` picks the UI's link layout (GitLab nests deep links under `/-/`).
It is derived from the host name — hosts containing `github` or `gitlab` are
recognized — so pass it only when the host doesn't give it away (e.g.
`code.example.com`). With no recognized host and no `provider`, the UI shows
the sync metadata without links.

The response returns the notebook plus its sync credentials:

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

### View or edit sync settings

In the project notebook menu, open **Sync settings** to view the repository,
branch, repo folder, entry notebook, sync URL, and last successful sync. Project
editors can change all four source coordinates:

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

When editing, a bare `owner/repo` keeps naming a path on the host the source
already lives on; github.com shorthand stays bare.

Before the first successful sync, changes take effect immediately. After that,
changes remain pending until a push or server pull matches the new source
coordinates. The notebook continues to serve its last successful version in
the meantime. Editing the source does not change the sync URL or rotate its
token.

## Server-initiated sync with GitHub

For GitHub notebooks, this method can replace push step 2. The deployment must
have a configured [GitHub App](configuration.md#source-control-publishing). A
project editor can compare a notebook with its branch head and pull that commit
into marimohub. This method currently supports GitHub.com repositories only.

The deployment advertises supported providers in
`source_control.sync_providers` from `GET /api/v1/capabilities`. The list
contains `"github"` when the GitHub App is configured. The notebook's
`source.provider` must appear in this list.

The API provides two endpoints:

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

The sync endpoint downloads the repository tree under `root_path` at the
resolved commit. It applies the same file-count and size limits as push sync to
the files under `root_path`. Files outside `root_path` do not count against
these limits, so a small subtree can sync from a large monorepo. The repository
download itself is limited to 100 MB compressed and 2 GB uncompressed. If
no source settings are pending and the notebook already points to that commit,
it returns `synced: false` and does not create a version. A successful sync
against pending source settings makes those settings active. The response also
includes the resolved `commit` and the new `version_id`. The `version_id` is
`null` for a no-op.

The web interface shows the drift status and a **Sync now** button in **Sync
settings** and in the repository popover. The button is available only to
editors when the source provider supports server-initiated sync.

Push sync and server-initiated sync share commit-based idempotency. If either
method already synced a commit, the other method does not create a duplicate
version. GitHub archives do not include `.git`, so a server-pulled workspace
supports entry-notebook publishing only. To capture changes across multiple
files, use push sync and [include `.git`](#include-git-for-multi-file-publishing).

## 2. Push an archive

Use push sync for GitLab, self-hosted Git providers, or deployments without a
GitHub App. You can also use it for GitHub notebooks that support **Sync now**.

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

Upload `/tmp/sync.tgz` with the headers from [Push an archive](#_2-push-an-archive).
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
session workspace. If `.git` or the `git` binary is unavailable, capture uses
the entry-notebook fallback. If Git cannot resolve `X-Marimohub-Commit`,
publishing fails without falling back.

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

```http
POST /api/v1/projects/{pid}/notebooks/{nid}/sync-token/rotate
```

Returns a fresh `sync_url` + `sync_token`.

## Dependencies

A session environment starts with the packages in the sandbox image. marimohub
then applies dependency sources from the synced workspace in this order:

- If the synced root contains `pyproject.toml`, `uv sync --inexact` adds its
  dependencies to the base environment. If this command fails, the session
  continues with the base environment.
- [PEP 723](https://peps.python.org/pep-0723/) inline metadata
  (`# /// script … # ///`) in the entry notebook adds another dependency layer.
  marimohub installs these dependencies with `uv export --script` and
  `uv pip install`. If uv cannot resolve them, the session fails.

If both sources declare the same package, the inline metadata takes precedence.
No configuration is necessary. marimohub selects the dependency strategy when
the session starts.

## Read-only sessions

Each session starts from the latest synced version. Session edits do not change
that version. The sandbox is discarded on teardown. Users can publish edits
before teardown, but publishing does not create a marimohub version. A session
cannot start before the first successful sync (`400` otherwise).

### Publishing edits back to the repository

When [source-control publishing](configuration.md#source-control-publishing) is
configured, a project manager can publish edits from a persistent editor
session. The current GitHub App integration creates an immutable proposal and a
draft pull request.

After the first publication, the editor shows **View PR** and two more actions:

- **Update PR** publishes a new proposal to the same pull request. It adds a
  commit when possible. Otherwise, marimohub rebuilds the proposal branch from
  the synced base. It never overwrites external branch changes.
- **Create new PR** opens another pull request and replaces the displayed link.
  The previous pull request remains on GitHub.

The web interface uses this endpoint:

```http
POST /api/v1/projects/{pid}/notebooks/{nid}/sessions/{sid}/change-requests
```

If the synced version [includes `.git`](#include-git-for-multi-file-publishing),
the proposal can contain changes from the full working tree. Otherwise, the
proposal contains only the entry notebook. Each proposal supports 1,000 changes
and 10 MB of added or modified content.
