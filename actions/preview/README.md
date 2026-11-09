# marimo Hub PR previews

This Action publishes previews through one or more existing Git-synced notebooks.
It uses each notebook's GitHub App connection to read code.
It does not check out or execute repository code on the runner.

## Install

The Hub needs a Git-synced notebook, a GitHub App connection for its repository, and preview maintenance.
The token owner must be a notebook manager or admin. The runner must be able to reach the Hub over HTTPS.
HTTP is allowed only for loopback addresses or `localhost`, for local use.
Previews use the notebook's access rules, integrations, and secrets.

1. Open **Previews → Set up GitHub Action** on the notebook.
2. Choose the preview settings.
3. Create a Hub API token with this project's `preview.manage` grant.
4. Add the token as the repository's `MARIMOHUB_TOKEN` Actions secret.
5. Save the generated workflow as `.github/workflows/notebook-previews.yml`.
6. Review the pinned Action revision before committing the workflow.

For installation without the UI, use the workflow below and replace `PROJECT`, `NOTEBOOK`, and the Hub URL.

## Generic workflow

```yaml
name: Notebook previews
on:
  pull_request:
    types: [opened, reopened, synchronize, closed]
permissions:
  actions: read
  pull-requests: write
concurrency:
  group: marimo-preview-${{ github.event.pull_request.number }}
  queue: max
  cancel-in-progress: false
jobs:
  preview:
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: marimo-team/marimohub/actions/preview@9eaf45e8d4bbc2b90b7f7a5bb75d2c3df78eda32 # preview Action
        with:
          hub-url: https://hub.example.com
          project-id: PROJECT
          notebook-id: NOTEBOOK
          hub-token: ${{ secrets.MARIMOHUB_TOKEN }}
          mode: sticky
          keep: '5'
          eager: 'true'
          # idle-days: '7'
```

The workflow grants `actions: read` for run metadata and `pull-requests: write` for the PR comment.
It supports same-repository PRs, including drafts, and skips forks.
All workflows that update the shared comment must use this same PR concurrency group.
Run multiple Action steps sequentially within a job. Concurrent matrix jobs can overwrite comment rows.
GitHub comment updates do not support compare-and-swap.

The runner must support the Node 24 Action runtime. The GitHub instance must support `concurrency.queue: max`.
GitHub queues up to 100 runs per group.

## Bulk previews

Use `targets` instead of `project-id` and `notebook-id` to preview multiple notebooks.
The input is a JSON array of project/notebook pairs, with an optional display name for each notebook.
A batch can contain up to 100 unique pairs across projects on the same Hub.
The token needs `preview.manage` grants for every target project.
Each notebook must sync with the PR repository.

Replace the Action step in the generic workflow with this step.
Replace `BULK_PREVIEW_ACTION_SHA` with a reviewed commit that includes bulk preview support.
The older pin in the single-notebook example does not support `targets`.

```yaml
- uses: marimo-team/marimohub/actions/preview@BULK_PREVIEW_ACTION_SHA
  with:
    hub-url: https://hub.example.com
    hub-token: ${{ secrets.MARIMOHUB_TOKEN }}
    targets: |
      [
        {"project-id": "PROJECT_A", "notebook-id": "NOTEBOOK_A", "name": "Sales dashboard"},
        {"project-id": "PROJECT_A", "notebook-id": "NOTEBOOK_B", "name": "Revenue report"},
        {"project-id": "PROJECT_B", "notebook-id": "NOTEBOOK_C"}
      ]
    mode: sticky
    eager: 'true'
```

The preview settings apply to every target in the batch.
For different settings or tokens, use sequential Action steps with the same Hub URL.
Each step replaces its notebooks' table rows and preserves rows for other notebooks.
Commit mode shows one row per retained commit.

The Action attempts every target, even after a failure.
It publishes successful previews and error rows, then fails the step if any target failed.
Outputs contain only successful targets. The workflow log identifies each failed target.

When upgrading, keep the existing workflow file to preserve its GitHub workflow ID.
Update all preview workflows to the shared concurrency group before using bulk previews.
The Action reuses matching old per-notebook comments and deletes duplicates after the consolidated comment update succeeds.
Only legacy comments for the configured targets are migrated.
Removing a target from the configuration does not retire its previews or delete its table rows.
Keep targets configured through PR closure. Hub maintenance still retires previews after closure if the workflow misses the event.

## Inputs

| Input          | Default               | Purpose                                                                   |
| -------------- | --------------------- | ------------------------------------------------------------------------- |
| `hub-url`      | Required              | Hub base URL                                                              |
| `project-id`   | Single target only    | Parent project                                                            |
| `notebook-id`  | Single target only    | Parent Git-synced notebook                                                |
| `targets`      | Unset                 | JSON array of project/notebook pairs, instead of the single-target inputs |
| `hub-token`    | Required              | Hub API token with `preview.manage` for every target project              |
| `github-token` | `${{ github.token }}` | Read workflow run metadata and update the PR comment                      |
| `mode`         | `sticky`              | `sticky` or `commits`                                                     |
| `keep`         | `5`                   | Retain 1–25 commit previews per PR and notebook                           |
| `eager`        | `true`                | Prepare code automatically; `false` defers preparation until a visit      |
| `idle-days`    | Unset                 | Expire after 1–30 days without a new head commit                          |

## Behavior

Sticky mode keeps one `<branch>` preview at a stable URL. Commit mode keeps separate `<branch>-<12-character-sha>` previews for the latest distinct pushed heads.
Each workflow event selects one full head SHA. The Hub prepares that commit, even if the branch advances before preparation starts.
Canceled or missed workflow runs do not create targets. Commit retention uses the original event order, not arrival or rerun time.
Long names use a truncated branch and deterministic hash suffix.

Eager mode prepares each accepted target automatically. Lazy mode requires an authorized visit for each new target.
Once requested, preparation retries after failures without another visit. A later target requires a new visit.
Compute starts when a user opens an app or editor. Existing sessions keep their revision, and failed updates preserve the last prepared revision.

Closing or merging the PR retires all managed previews. With `idle-days`, a new head renews the timeout for the whole group.
Reruns do not renew it. A new commit after expiry or a reopened PR starts a new lifecycle.
Changing modes retires the previous mode's previews. Manual previews remain separate.

## Results and limits

The Action returns after the Hub accepts the update. It merges preview links, commits, preparation states, and capacity waits into one table per PR and Hub URL.
The workflow summary contains results for the current step. Comment failures produce a warning and preserve successful outputs.
If the merged table exceeds 60,000 characters, comment updates produce a warning.
The summary and outputs remain available. Reduce commit retention or shorten display names.
Comments reflect the Action response, not later background preparation.

All outputs are JSON:

- `previews`: objects with `project_id`, `notebook_id`, `id`, `url`, `commit`, and `preparation`.
- `preview-ids`, `preview-urls`, `commits`: arrays of retained IDs, URLs, and full head SHAs.

The shared project limit is 25 previews, including manual previews and pending cleanup.
The Hub retries capacity waits without another commit. The Previews page shows previews created after the Action returns.
Existing workspace and compute limits apply. Each project can have up to 1,000 active automation groups, including groups waiting for preview capacity.
Retired groups retain compact replay records outside that limit. Old PRs do not exhaust capacity for new groups.

## Maintenance and upgrades

Maintenance prepares accepted targets and retries pending work. It checks PR closure independently, even for lazy previews or a missed close workflow.
It does not discover new commits for managed previews. New targets come from workflow events.
GitHub outages delay closure checks. Configured inactivity expiry still applies.

Keep the managing workflow file in place: each notebook and PR group is bound to one GitHub workflow ID.
Pin the Action to a reviewed commit SHA. Deploy a compatible Hub version before updating that pin.

Stop Hub writers while upgrading all replicas. The new version reads older records, but older versions cannot read compact project intents or null expiry.
Upgrade API clients to accept `expires_at: null` for previews without a timeout. Existing manual previews retain their finite expiry.
