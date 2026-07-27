---
description: Push read-only notebooks into marimohub from external source systems.
---

# Syncing from external sources

> **Status: work in progress.** Synced sources are usable but evolving. The
> request/response shapes documented here are not yet stable, and there is no
> backwards-compatibility guarantee between releases.

marimohub can serve a notebook whose source of truth lives **outside** the
platform — today, a **git repository** mirrored in by an external pusher such as
a CI workflow. The platform never reaches out to the repository host; content
only ever arrives by **push**. That means:

- No host credentials are stored on the server, and there is no outbound network
  call to a provider — so no SSRF surface.
- The push is authenticated by a **notebook-scoped sync token**, not a user
  cookie, so it works cleanly from headless CI.

A synced notebook is a **read-only mirror**. Each push is captured as an
immutable version; running sessions get a fresh copy of the latest pushed
version. See [Read-only sessions](#read-only-sessions) below.

## How it works

```
┌─────────────┐   git push / CI   ┌──────────────────────┐
│ your repo   │ ────────────────▶ │ POST {sync_url}      │
│ (GitHub …)  │   archive + token │  (archive of subtree)│
└─────────────┘                   └──────────┬───────────┘
                                             │ writes versions/{vid}/workspace/
                                             │ then CAS-advances source.json
                                             ▼
                                  ┌──────────────────────┐
                                  │ immutable version =   │
                                  │ unit of truth         │
                                  └──────────────────────┘
```

Each sync writes the uploaded files into a fresh `versions/{vid}/workspace/`
mirror and then compare-and-swaps the notebook's source pointer to it. There is
no mutable mirror to corrupt, so concurrent pushes are safe: the source pointer
always references exactly one version, never an interleaving of two.

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

| Field            | Required | Notes                                                                       |
| ---------------- | -------- | --------------------------------------------------------------------------- |
| `provider`       | no       | Where the repo is hosted. Currently `github`; defaults to `github`.         |
| `repo`           | yes      | `owner/name`. Informational + matched on each push.                         |
| `branch`         | yes      | Branch this notebook tracks.                                                |
| `root_path`      | no       | Repo subdirectory whose tree is mirrored. Defaults to the repo root (`""`). |
| `entry_notebook` | yes      | The `.py` notebook to open, **relative to `root_path`**.                    |

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

## 2. Push an archive

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
| `X-Marimohub-Repo`           | yes      | Must match the notebook's `repo`.                           |
| `X-Marimohub-Branch`         | yes      | Must match the notebook's `branch`.                         |
| `X-Marimohub-Root-Path`      | no       | Must match the notebook's `root_path` (defaults to `""`).   |
| `X-Marimohub-Commit`         | yes      | The git commit SHA being pushed.                            |
| `X-Marimohub-Archive-Format` | no       | `zip`, `tar`, or `tar.gz`. Otherwise sniffed from the body. |

`X-Marimohub-Repo` / `-Branch` / `-Root-Path` re-state the notebook's
configuration so a misrouted workflow can't push to the wrong notebook; a
mismatch is rejected with `400`.

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

### Idempotency

Git commit SHAs are content-addressed, so re-pushing the **same commit** is a
no-op — safe to retry. Pushing a **new commit** cuts a new immutable version and
advances the notebook.

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

## Rotating the sync token

If a token leaks, rotate it. The old token stops working immediately.

```http
POST /api/v1/projects/{pid}/notebooks/{nid}/sync-token/rotate
```

Returns a fresh `sync_url` + `sync_token`.

## Read-only sessions

Sessions on a synced notebook are **ephemeral**: the sandbox is populated from
the latest pushed version, and edits made in the session are **discarded** on
teardown — nothing is committed back to the store or to git. A session cannot be
started until the notebook has been pushed at least once (`400` otherwise).

### Write-back is not yet supported

There is currently **no path to push session edits back to the source
repository** (e.g. opening a pull request). Treat synced notebooks as
run-and-explore mirrors of the repo; make changes in the repo and let the next
push update the notebook. Write-back is planned but not implemented.
