---
description: A visual tour of marimohub projects, notebook workflows, collaboration, apps, and automation.
---

# Feature gallery

Explore marimohub through sample projects and notebooks. Available features and compute choices depend on your deployment.
Select any screenshot to open it at full size.

## Projects and notebooks

Organize notebooks into shared projects. Each project has its own notebook list, tags, members, and environment configuration.

<figure class="doc-screenshot">
  <a href="/screenshots/gallery-projects.png" target="_blank" rel="noreferrer" aria-label="Open full-size screenshot: Projects page with Analytics, Machine learning, and Team knowledge projects (new tab)">
    <img src="/screenshots/gallery-projects.png" alt="Projects page with Analytics, Machine learning, and Team knowledge projects" width="798" height="351" loading="lazy" decoding="async" />
  </a>
</figure>

<figure class="doc-screenshot">
  <a href="/screenshots/gallery-notebooks.png" target="_blank" rel="noreferrer" aria-label="Open full-size screenshot: Analytics project with four tagged notebooks (new tab)">
    <img src="/screenshots/gallery-notebooks.png" alt="Analytics project with four tagged notebooks" width="798" height="406" loading="lazy" decoding="async" />
  </a>
</figure>

## Creating notebooks

Start with a blank notebook or upload a Python file. Choose from the [base images](./sandbox-image.md) and [compute profiles](./compute.md) your deployment offers.

<figure class="doc-screenshot doc-screenshot--portrait">
  <a href="/screenshots/gallery-create-notebook.png" target="_blank" rel="noreferrer" aria-label="Open full-size screenshot: Create notebook dialog with base images and standard or large compute profiles (new tab)">
    <img src="/screenshots/gallery-create-notebook.png" alt="Create notebook dialog with base images and standard or large compute profiles" width="510" height="640" loading="lazy" decoding="async" />
  </a>
</figure>

## Syncing with GitHub

Connect a repository, branch, and notebook file. The hub can [pull updates from GitHub](./syncing.md), or receive repository archives from CI.

<figure class="doc-screenshot doc-screenshot--portrait">
  <a href="/screenshots/gallery-github-sync.png" target="_blank" rel="noreferrer" aria-label="Open full-size screenshot: Git repository dialog with Connect to GitHub selected and example repository fields (new tab)">
    <img src="/screenshots/gallery-github-sync.png" alt="Git repository dialog with Connect to GitHub selected and example repository fields" width="446" height="588" loading="lazy" decoding="async" />
  </a>
</figure>

## Permissions

Inspect project access and assign members a [role](./auth.md): app user, viewer, editor, or manager.

<figure class="doc-screenshot doc-screenshot--narrow">
  <a href="/screenshots/gallery-permissions.png" target="_blank" rel="noreferrer" aria-label="Open full-size screenshot: Project Access dialog with the owner, member picker, and Viewer role selected (new tab)">
    <img src="/screenshots/gallery-permissions.png" alt="Project Access dialog with the owner, member picker, and Viewer role selected" width="510" height="510" loading="lazy" decoding="async" />
  </a>
</figure>

## Reactive notebook editing

Edit Python cells and see their outputs in marimo. Charts, tables, and interactive controls stay connected to the code that produces them.

<figure class="doc-screenshot">
  <a href="/screenshots/editor-chart.png" target="_blank" rel="noreferrer" aria-label="Open full-size screenshot: A marimo Python cell with its rendered revenue chart (new tab)">
    <img src="/screenshots/editor-chart.png" alt="A marimo Python cell with its rendered revenue chart" width="921" height="453" loading="lazy" decoding="async" />
  </a>
</figure>

## Workspace files

[Browse and edit workspace files](./editor-sessions.md#browse-and-edit-workspace-files) without starting a sandbox. Keep data, supporting code, and documentation beside the notebook.

<figure class="doc-screenshot">
  <a href="/screenshots/workspace-files.png" target="_blank" rel="noreferrer" aria-label="Open full-size screenshot: Workspace file tree and README editor (new tab)">
    <img src="/screenshots/workspace-files.png" alt="Workspace file tree and README editor" width="1062" height="390" loading="lazy" decoding="async" />
  </a>
</figure>

## Version history

Compare saved versions side by side, inspect code changes, and restore an earlier version.

<figure class="doc-screenshot">
  <a href="/screenshots/gallery-version-history.png" target="_blank" rel="noreferrer" aria-label="Open full-size screenshot: Version history with a side-by-side diff of the default region and restore controls (new tab)">
    <img src="/screenshots/gallery-version-history.png" alt="Version history with a side-by-side diff of the default region and restore controls" width="1066" height="470" loading="lazy" decoding="async" />
  </a>
</figure>

## Data source integrations

Choose from the [integration catalog](./integrations.md) to configure databases, catalogs, query engines, object storage, and other services for a project.

<figure class="doc-screenshot">
  <a href="/screenshots/gallery-integrations.png" target="_blank" rel="noreferrer" aria-label="Open full-size screenshot: Integration catalog with category filters and six database options (new tab)">
    <img src="/screenshots/gallery-integrations.png" alt="Integration catalog with category filters and six database options" width="1066" height="630" loading="lazy" decoding="async" />
  </a>
</figure>

## SQL querying

[Run SQL](./integrations.md#run-sql) against supported integrations from the Data page. Inspect query results and export them as CSV without starting a notebook.

<figure class="doc-screenshot">
  <a href="/screenshots/gallery-sql-querying.png" target="_blank" rel="noreferrer" aria-label="Open full-size screenshot: SQL editor with a PostgreSQL query and revenue totals for three regions (new tab)">
    <img src="/screenshots/gallery-sql-querying.png" alt="SQL editor with a PostgreSQL query and revenue totals for three regions" width="690" height="541" loading="lazy" decoding="async" />
  </a>
</figure>

## Object browser

[Browse object storage](./integrations.md#object-store-browsing), inspect metadata and versions, and preview supported files. Download an object or open it in a notebook.

<figure class="doc-screenshot doc-screenshot--portrait">
  <a href="/screenshots/gallery-object-browser.png" target="_blank" rel="noreferrer" aria-label="Open full-size screenshot: Object browser showing a CSV preview, metadata and versions tabs, and notebook and download actions (new tab)">
    <img src="/screenshots/gallery-object-browser.png" alt="Object browser showing a CSV preview, metadata and versions tabs, and notebook and download actions" width="480" height="696" loading="lazy" decoding="async" />
  </a>
</figure>

## Environment variables

Store [project environment variables](./environment-and-access.md) in versioned configuration. New sessions receive the latest values; running sessions keep their initial configuration.

<figure class="doc-screenshot">
  <a href="/screenshots/gallery-environment-variables.png" target="_blank" rel="noreferrer" aria-label="Open full-size screenshot: Environment variables form with DEFAULT_REGION and DATASET_VERSION sample values (new tab)">
    <img src="/screenshots/gallery-environment-variables.png" alt="Environment variables form with DEFAULT_REGION and DATASET_VERSION sample values" width="1066" height="372" loading="lazy" decoding="async" />
  </a>
</figure>

## Interactive apps

[Run a notebook as an app](./apps.md) to share its controls and outputs with people who do not need the editor.

<figure class="doc-screenshot">
  <a href="/screenshots/notebook-app.png" target="_blank" rel="noreferrer" aria-label="Open full-size screenshot: Revenue explorer app with a region selector and stacked bar chart (new tab)">
    <img src="/screenshots/notebook-app.png" alt="Revenue explorer app with a region selector and stacked bar chart" width="1000" height="560" loading="lazy" decoding="async" />
  </a>
</figure>

## Named app links

Give an app a short, memorable [link](./apps.md#authenticated-app-links). Recipients sign in and use the notebook’s existing permissions.

<figure class="doc-screenshot doc-screenshot--narrow">
  <a href="/screenshots/app-links.png" target="_blank" rel="noreferrer" aria-label="Open full-size screenshot: App links dialog with a named revenue link and access requirements (new tab)">
    <img src="/screenshots/app-links.png" alt="App links dialog with a named revenue link and access requirements" width="510" height="191" loading="lazy" decoding="async" />
  </a>
</figure>

## Jobs

[Schedule a notebook job](./jobs.md), or run it on demand. Jobs keep a run history with rendered output and logs.

<figure class="doc-screenshot doc-screenshot--narrow">
  <a href="/screenshots/job-schedule.png" target="_blank" rel="noreferrer" aria-label="Open full-size screenshot: New job form with a weekday schedule at 09:00 UTC (new tab)">
    <img src="/screenshots/job-schedule.png" alt="New job form with a weekday schedule at 09:00 UTC" width="670" height="334" loading="lazy" decoding="async" />
  </a>
</figure>

## Notifications

Choose which project events trigger [Slack or signed webhook alerts](./project-alerts.md), including failed jobs, app failures, and access changes. Operators can also configure [deployment-wide notifications](./notifications.md).

<figure class="doc-screenshot doc-screenshot--narrow">
  <a href="/screenshots/gallery-notifications.png" target="_blank" rel="noreferrer" aria-label="Open full-size screenshot: Project alerts form with app failures, Git sync failures, and failed jobs selected (new tab)">
    <img src="/screenshots/gallery-notifications.png" alt="Project alerts form with app failures, Git sync failures, and failed jobs selected" width="508" height="646" loading="lazy" decoding="async" />
  </a>
</figure>

## Gallery thumbnails

Switch a project to Gallery view to recognize notebooks by their outputs. [Upload and crop a custom thumbnail](./thumbnails.md) for each notebook.

<figure class="doc-screenshot doc-screenshot--card">
  <a href="/screenshots/notebook-gallery.png" target="_blank" rel="noreferrer" aria-label="Open full-size screenshot: Revenue explorer gallery card with a custom chart thumbnail (new tab)">
    <img src="/screenshots/notebook-gallery.png" alt="Revenue explorer gallery card with a custom chart thumbnail" width="376" height="362" loading="lazy" decoding="async" />
  </a>
</figure>

## Scoped API tokens

Give scripts and the CLI [personal API tokens](./api-tokens.md) limited to selected actions and projects.

<figure class="doc-screenshot doc-screenshot--narrow">
  <a href="/screenshots/gallery-api-tokens.png" target="_blank" rel="noreferrer" aria-label="Open full-size screenshot: API token permissions limited to running notebooks in the Analytics project (new tab)">
    <img src="/screenshots/gallery-api-tokens.png" alt="API token permissions limited to running notebooks in the Analytics project" width="494" height="482" loading="lazy" decoding="async" />
  </a>
</figure>
