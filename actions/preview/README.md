# marimo Hub PR previews

This Action publishes previews through an existing Git-synced notebook.
It uses the notebook's GitHub App connection to read code.
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
6. Replace `@main` with a reviewed commit SHA that contains this Action.

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
  group: marimo-preview-PROJECT-NOTEBOOK-${{ github.event.pull_request.number }}
  queue: max
  cancel-in-progress: false
jobs:
  preview:
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: marimo-team/marimohub/actions/preview@main
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
Use a separate job and concurrency group for each notebook.

The runner must support the Node 24 Action runtime. The GitHub instance must support `concurrency.queue: max`.
GitHub queues up to 100 runs per group. Canceled or undelivered events do not create commit previews.

## Inputs

| Input          | Default               | Purpose                                                              |
| -------------- | --------------------- | -------------------------------------------------------------------- |
| `hub-url`      | Required              | Hub base URL                                                         |
| `project-id`   | Required              | Parent project                                                       |
| `notebook-id`  | Required              | Parent Git-synced notebook                                           |
| `hub-token`    | Required              | Hub API token with `preview.manage`                                  |
| `github-token` | `${{ github.token }}` | Read workflow run metadata and update the PR comment                 |
| `mode`         | `sticky`              | `sticky` or `commits`                                                |
| `keep`         | `5`                   | Retain 1–25 commit previews per PR and notebook                      |
| `eager`        | `true`                | Prepare code automatically; `false` defers preparation until a visit |
| `idle-days`    | Unset                 | Expire after 1–30 days without a new head commit                     |

## Behavior

Sticky mode keeps one `<branch>` preview at a stable URL. Commit mode keeps separate `<branch>-<12-character-sha>` previews for the latest distinct pushed heads.
A push creates one preview for its head. Long names use a truncated branch and deterministic hash suffix.

Eager mode prepares code after each update. Lazy mode requires an authorized visit for each new head.
Compute starts when a user opens an app or editor. Existing sessions keep their revision, and failed updates preserve the last prepared revision.

Closing or merging the PR retires all managed previews. With `idle-days`, a new head renews the timeout for the whole group.
Reruns do not renew it. A new commit after expiry or a reopened PR starts a new lifecycle.
Changing modes retires the previous mode's previews. Manual previews remain separate.

## Results and limits

The Action returns after the Hub accepts the update. It labels pending preparation and capacity waits in one PR comment per notebook and Hub URL.
The workflow summary contains the same links. Comment failures produce a warning and preserve successful outputs.
Comments reflect the Action response, not later background preparation.

All outputs are JSON:

- `previews`: objects with `id`, `url`, `commit`, and `preparation`.
- `preview-ids`, `preview-urls`, `commits`: arrays of retained IDs, URLs, and full head SHAs.

The shared project limit is 25 previews, including manual previews and pending cleanup.
The Hub retries capacity waits without another commit. The Previews page shows previews created after the Action returns.
Existing workspace and compute limits apply. Each project retains up to 1,000 automation groups, including closed groups, to reject delayed replays.

## Maintenance and upgrades

Maintenance prepares code, retries pending work, and checks PR closure even when the close workflow does not run.
GitHub outages delay closure checks. Configured inactivity expiry still applies.

Keep the managing workflow file in place: each notebook and PR group is bound to one GitHub workflow ID.
Pin the Action to a reviewed commit SHA. Deploy a compatible Hub version before updating that pin.

Before first use, upgrade all Hub replicas and API clients. Clients must accept `expires_at: null` for previews without a timeout.
Older Hub versions cannot read these records. Existing finite-expiry records need no migration.
