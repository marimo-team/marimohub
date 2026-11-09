# marimo Hub PR previews

This Action publishes previews through one or more existing Git-synced notebooks.
It uses each notebook's GitHub App connection to read code.
It does not check out or execute repository code on the runner.
The Hub manages preview lifecycle, retention, closure checks, and limits.
See [Automatic PR previews](../../docs/notebook-previews.md#automatic-pr-previews) for that behavior.

## Install

The Hub needs a Git-synced notebook, a GitHub App connection for its repository, and preview maintenance.
The token owner must be a notebook manager or admin. The runner must be able to reach the Hub over HTTPS.
HTTP is allowed only for loopback addresses or `localhost`, for local use.
Previews use the notebook's access rules, integrations, and secrets.
Read [Security model → Previews](../../docs/security.md#previews) before you install.

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
    if: github.event.pull_request.head.repo.full_name == github.repository && github.actor != 'dependabot[bot]'
    runs-on: ubuntu-latest
    steps:
      - uses: marimo-team/marimohub/actions/preview@a3dd178fde69fe04611882c0c5b2c753e2125cd1 # preview Action
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
It supports same-repository PRs, including drafts, and skips forks and Dependabot runs.
If `hub-token` is empty, the Action writes a note to the workflow summary and skips the PR.
GitHub gives no Actions secrets to Dependabot `pull_request` runs, so the Action skips Dependabot PRs.
All workflows that update the shared comment must use this same PR concurrency group.
Run multiple Action steps sequentially within a job. Concurrent matrix jobs can overwrite comment rows.
GitHub comment updates do not support compare-and-swap.

The runner must support the Node 24 Action runtime.
Only GitHub.com and GitHub Enterprise Cloud support `concurrency.queue: max`. GitHub queues up to 100 runs per group.

### GitHub Enterprise Server

GitHub Enterprise Server rejects `queue: max`. Remove that line from the workflow:

```yaml
concurrency:
  group: marimo-preview-${{ github.event.pull_request.number }}
  cancel-in-progress: false
```

Without the queue, GitHub keeps only the newest pending run in the group and cancels older pending runs.
A canceled run does not create its target. Commit mode can then skip intermediate commits.
Hub [closure checks](../../docs/notebook-previews.md#pr-closure-checks) still retire previews after a missed close event.

## Bulk previews

Use `targets` instead of `project-id` and `notebook-id` to preview multiple notebooks.
The input is a JSON array of project/notebook pairs, with an optional display name for each notebook.
A batch can contain up to 100 unique pairs across projects on the same Hub.
The token needs `preview.manage` grants for every target project.
Each notebook must sync with the PR repository.

Replace the Action step in the generic workflow with this step.
Both examples use the same pinned revision, which supports single and bulk previews.

```yaml
- uses: marimo-team/marimohub/actions/preview@a3dd178fde69fe04611882c0c5b2c753e2125cd1
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

Before you use bulk previews, move all preview workflows to the shared concurrency group.
The Action reuses matching per-notebook comments from older Action revisions.
After the shared comment update succeeds, it deletes the duplicates.
The Action migrates only the comments of configured targets.
Removing a target from the configuration does not retire its previews or delete its table rows.
Keep targets configured through PR closure. Hub [closure checks](../../docs/notebook-previews.md#pr-closure-checks) still retire previews if the workflow misses the close event.

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
| `keep`         | `5`                   | Number of commit previews to retain in `commits` mode                     |
| `eager`        | `true`                | Prepare code automatically; `false` defers preparation until a visit      |
| `idle-days`    | Unset                 | Inactivity timeout in days; unset keeps previews until the PR closes      |

The Hub applies `mode`, `keep`, `eager`, and `idle-days` as the group's retention policy.
See [Lifecycle](../../docs/notebook-previews.md#lifecycle) for their ranges and behavior.

## Results

The Action returns after the Hub accepts the update. It merges preview links, commits, preparation states, and capacity waits into one table per PR and Hub URL.
The workflow summary contains results for the current step. Comment failures produce a warning and preserve successful outputs.
If the merged table exceeds 60,000 characters, comment updates produce a warning.
The summary and outputs remain available. Reduce commit retention or shorten display names.
Comments reflect the Action response, not later background preparation.
The Previews page shows previews that the Hub creates after the Action returns.

All outputs are JSON:

- `previews`: objects with `project_id`, `notebook_id`, `id`, `url`, `commit`, and `preparation`.
- `preview-ids`, `preview-urls`, `commits`: arrays of retained IDs, URLs, and full head SHAs.

## Pinning

The Hub binds each notebook and PR group to one GitHub workflow ID.
Do not rename or move the workflow file.
Pin the Action to a reviewed commit SHA.
Before you update the pin, deploy a Hub version that supports the new Action revision.
