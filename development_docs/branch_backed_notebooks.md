# Branch-backed notebooks

|             |                  |
| ----------- | ---------------- |
| **Status**  | Draft for review |
| **Created** | 2026-11-10       |

## Summary

Let a user start a notebook on a **new working branch forked from a base branch** (such as `dev` or
`main`), save session edits as commits **on that working branch**, and open one pull request from
the working branch into the base. The whole flow is available from project chat and the MCP server,
as well as from the web interface.

This builds on existing pieces: pull-mode git sources, proposal capture, the `SourceControlPublisher`
port, and `sync_notebook_source`. The main change is that the hub writes to the branch the notebook
tracks, instead of always writing to a separate proposal branch.

## Motivation

A git-synced session is read-only by design. It starts from the last synced version, and its edits
are discarded at teardown, even with `MARIMOHUB_PERSIST_WORKSPACE=workspace`
([syncing.md, Read-only sessions](../docs/syncing.md#read-only-sessions)). The only way to keep
work is to publish a change request before the session ends, then merge it and sync.

In practice, authors who work from a git repository hit three problems:

1. **Restarts lose work.** A restart, the idle reap, or a stop throws away edits since the last
   publish. The next session starts from the old commit, so recent work appears to have reverted.
2. **Saving is a review action.** The only save path opens or updates a draft PR into the tracked
   branch, and it requires the project `manager` role. Authors who just want to keep their work
   must either hold that role or lose edits.
3. **The tracked branch is the review target.** Because proposals target the tracked branch, a
   notebook that tracks `dev` sends every save towards `dev`. There is no place for unfinished work
   that is not yet ready for review.

Teams that already use branches want the usual git loop instead: branch off `dev`, commit as you
go, open one PR when ready. The tracked branch then always holds the author's latest saved work,
so a new session resumes where the last one stopped.

## Goals

1. Create a notebook from a new branch forked from a chosen base branch, in one step.
2. Save session edits as a commit on the working branch, then advance the notebook to that commit,
   so later sessions start from the saved work.
3. Open, and keep updating, one pull request from the working branch into its base.
4. Expose every step to project chat and MCP, with consent cards, under the caller's project role.
5. Optionally save unsaved edits to the working branch automatically when a session ends.
6. Keep the existing trust boundary: provider credentials stay on the server, and the sandbox only
   supplies file bytes.

## Non-goals

- Changing existing git-synced notebooks or the current proposal-branch flow. Both keep working.
- Merging pull requests, resolving conflicts, or rebasing working branches from the hub.
- Per-user git credentials or per-user commit authorship. Attribution stays on the existing model:
  the provider integration commits, and the user is a `Co-authored-by` trailer.
- GitLab and Azure DevOps in the first version. The port design must allow them; the first adapter
  is GitHub.

## Design

### Working-branch source

A branch-backed notebook is a pull-mode git source with one added record:

```json
{
	"repo": "acme/analytics",
	"branch": "marimohub/jdoe/sales-dashboard",
	"root_path": "apps",
	"entry_notebook": "dashboard.py",
	"sync_mode": "pull",
	"working_branch": {
		"base_branch": "dev",
		"fork_commit": "9f2c1ab…",
		"created_by": "<marimohub user id>",
		"change_request": null
	}
}
```

- `branch` is the working branch. Sync, previews, and sessions use it exactly as they use any
  tracked branch today.
- `working_branch.base_branch` is the pull request target. `fork_commit` records where the branch
  started.
- `working_branch.change_request` is filled in when the pull request is opened (see below).

Notebooks without `working_branch` behave as they do today.

### Create

`POST /api/v1/projects/{pid}/notebooks/git` accepts a new optional `fork` object:

```json
{
	"title": "Sales dashboard",
	"repo": "acme/analytics",
	"root_path": "apps",
	"entry_notebook": "dashboard.py",
	"sync_mode": "pull",
	"fork": { "base_branch": "dev", "branch": "marimohub/jdoe/sales-dashboard" }
}
```

The server:

1. Checks the repository policy and the branch-name policy (see below).
2. Resolves the head of `base_branch` and creates `branch` at that commit through the publisher.
   Creating a branch that already exists fails with `409`, unless that branch already points at the
   resolved base commit (an idempotent retry).
3. Creates the pull-mode notebook tracking `branch`, and performs the first sync.

`branch` is optional. When omitted, the server derives
`<prefix><user-slug>/<notebook-slug>` and adds a short suffix if the name is taken.

The request requires an `Idempotency-Key`. The key fixes the branch name and the notebook id, so a
retry after a timeout resumes rather than creating a second branch.

### Save

`POST /api/v1/projects/{pid}/notebooks/{nid}/sessions/{sid}/saves` commits the session's changes to
the working branch:

1. Capture runs exactly as it does for change requests (`git-working-tree`, same limits and
   exclusions) and stores an immutable proposal.
2. The publisher appends one commit to the working branch. The update is a compare-and-swap on the
   branch head: it succeeds only if the head is still the commit the hub last wrote or synced.
3. The server syncs the notebook to the new commit, so the stored version matches the branch.
4. The session's pinned base moves to the new commit. The next save diffs against it, so each
   commit holds only the new changes.

If someone pushes to the working branch from elsewhere, the head no longer matches and the save
fails with `409 BRANCH_MOVED`. The session's edits stay in place. The user syncs, restarts, and
re-applies, or saves to a new branch. Saves never force-push. The existing GitHub
"rebuild from base" fallback (`replacePullRequestHead`, which uses `forceUpdateRef`) must be
disabled for working branches, because they can contain commits the hub did not write.

A save with no changes is a no-op, and it returns the current head commit.

### Open a pull request

`POST /api/v1/projects/{pid}/notebooks/{nid}/change-requests` opens a pull request from the working
branch into `working_branch.base_branch`, and stores the result in `working_branch.change_request`.
Later saves update that pull request automatically, since it is the PR's head branch. A second call
returns the existing pull request rather than opening another one.

The pull request opens as a draft by default. Title and body come from the request, or default
to the notebook title and a list of saved commits.

### Automatic save on teardown

With `MARIMOHUB_SOURCE_CONTROL_WORKING_BRANCH_AUTOSAVE=on`, the session retirement path saves to the
working branch before it destroys the sandbox. This covers idle reaps, explicit stops, and hub-driven
restarts. The commit is attributed to the session owner. If the save fails (for example with
`BRANCH_MOVED`, or because limits are exceeded), retirement continues as it does today, and the
failure is recorded on the session as an audit event and shown on the notebook page. Autosave never
blocks teardown indefinitely; it shares the existing teardown time budget.

This replaces the current "edits discarded at teardown" behaviour for branch-backed notebooks only.
The persistence mode in the session context file reports `branch` for these sessions, so tools can
tell users their work is saved on teardown.

### Branch-name policy

The provider identity gains write access to branches, so the hub must not be able to write to
protected or shared branches:

| Variable                                           | Default      | Description                                                                                              |
| -------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------- |
| `MARIMOHUB_SOURCE_CONTROL_WORKING_BRANCH_PREFIX`   | `marimohub/` | Working branches must start with this prefix. Create, save, and autosave refuse other names.             |
| `MARIMOHUB_SOURCE_CONTROL_WORKING_BRANCH_BASES`    | unset        | Optional JSON list of allowed base branches, such as `["dev","main"]`. Unset allows any existing branch. |
| `MARIMOHUB_SOURCE_CONTROL_WORKING_BRANCH_AUTOSAVE` | `off`        | `on` saves to the working branch at session teardown.                                                    |

The prefix check is a hub-side guard. Repository branch protection on the base branches is still
recommended.

### Roles

| Action                          | Proposed minimum role               | Reason                                                             |
| ------------------------------- | ----------------------------------- | ------------------------------------------------------------------ |
| Create a branch-backed notebook | `editor`                            | Same as creating a pull source today.                              |
| Save to the working branch      | `editor`                            | Writes only to a prefix-restricted branch that nobody reviews yet. |
| Open a pull request             | `editor`, configurable to `manager` | Opening a PR is a request for review, not a merge.                 |
| Sync                            | `editor`                            | Unchanged.                                                         |

This lowers the role for saving compared with change requests today. The
[source-control design notes](./source_control_publishing.md#v1-boundaries) already anticipate a
capture step for editors, with approval kept separate.

### Chat and MCP tools

| Tool                     | Purpose                                                                                                   | Consent                                |
| ------------------------ | --------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `create_branch_notebook` | Fork a branch from a base and create a notebook that tracks it. Optional `launch` starts an edit session. | Always asks (creates a remote branch). |
| `save_to_branch`         | Commit the session's changes to the working branch and sync. Returns the commit and changed paths.        | Can be remembered per project.         |
| `open_change_request`    | Open, or return, the pull request from the working branch into its base.                                  | Can be remembered per project.         |
| `sync_notebook_source`   | Existing.                                                                                                 | Unchanged.                             |

A typical chat session:

1. "Start a new app off dev called sales dashboard." Chat calls `create_branch_notebook` with
   `launch: true` and returns the notebook link.
2. The user edits in the notebook, or asks the assistant to.
3. "Save my work." Chat calls `save_to_branch`.
4. "Open a PR." Chat calls `open_change_request` and returns the link.
5. Later saves update the pull request. After the merge, the notebook can be archived.

The web interface gets matching actions:

- **Editor header.** For branch-backed notebooks, `ChangeRequestActions` in the notebook page
  header shows **Save** as the main action, next to **Open PR**. Once the pull request exists,
  **Open PR** becomes **View PR**. It needs no **Update PR** or **Create new PR** menu, because saves
  update the pull request. Both actions follow the roles below rather than the current
  manager-only gate.
- **Git source details.** The dialog shows the base branch and the pull request link, alongside the
  existing drift status and **Sync now**.
- **Add a git repository.** A **New branch from** option takes a base branch and an optional
  branch name.

## Provider port changes

`SourceControlPublisher` gains optional operations. A provider that does not implement them does
not offer branch-backed notebooks, and the capabilities response omits it from a new
`source_control.working_branch_providers` list.

```ts
interface SourceControlPublisher {
	// existing: openChangeRequest, updateChangeRequest?
	createBranch?(input: {
		repository: string;
		branch: string;
		fromCommit: string;
	}): Promise<{ commit: string }>;
	appendCommit?(input: {
		repository: string;
		branch: string;
		expectedHead: string;
		baseCommit: string;
		message: string;
		coAuthor?: CoAuthor;
		changes: ProposalChange[];
	}): Promise<{ commit: string }>;
	openBranchChangeRequest?(input: {
		repository: string;
		headBranch: string;
		baseBranch: string;
		title: string;
		body: string;
		draft: boolean;
	}): Promise<OpenChangeRequestResult>;
}
```

The GitHub adapter already has the primitives: `createRef`, `getRef`, the non-force `updateRef`
used when it appends to an existing proposal branch, and the pull request listing used to find an
existing PR.

## Security

- The sandbox still never receives provider credentials. It supplies file bytes, which the control
  plane hashes and stores before it calls the provider.
- Writes are limited to repositories allowed by `ALLOWED_REPOSITORIES` and branches matching the
  working-branch prefix.
- Previews of a working branch run that branch's code with the notebook's credentials, as previews
  do today. Anyone with push access to the working branch can supply that code. The prefix guards
  hub writes, not pushes from outside.
- Autosave commits as the session owner. In `shared` editor mode, the owner is whoever started the
  sandbox, which matches how saves are attributed today.

## Alternatives considered

1. **Keep the proposal-branch flow and save by updating a draft PR.** It works today, but saves need
   the `manager` role, every save is aimed at the tracked branch, and edits are still lost at
   teardown.
2. **Push from the kernel with a provider token.** The assistant could run `git push` through
   `execute_code`. That puts credentials in the sandbox and breaks the existing trust boundary, and
   creating the notebook would still need a server-side tool.
3. **Edit a local notebook and export to git at the end.** Restarts would be safe, but local
   notebooks cannot publish to a provider, and the hub copy and the repository would drift.

## Open questions

1. Should autosave be per notebook as well as per deployment?
2. Should a branch-backed notebook switch to tracking `base_branch` after its pull request merges, or
   be archived?
3. Is `editor` the right default for opening a pull request?
4. How should `BRANCH_MOVED` be offered in the editor: sync-and-restart, or save to a new branch?
5. Should the working branch be deleted when the notebook is deleted?
