---
description: Organize projects into namespaces with path tags.
---

# Organizing projects

Tags such as `acme/research/vision` organize projects into namespaces.
A project can belong to several namespaces without changes to its ID, URL, or access rules.

## Path tags

Path tags use lowercase letters, digits, dots, underscores, and hyphens, with `/` between segments.
Each segment starts with a letter or digit:

```text
[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)*
```

`research`, `research/vision`, and `team-a/repo_1` form namespaces.
Other tags, such as `Research`, `team a`, or `research/`, remain ordinary tags.
The API stores tags as supplied, without normalization.

## Browse namespaces

The project list shows one section per top-level namespace by default. A project appears in each matching namespace. The total counts each project once.
Each namespace section previews up to five projects.
Projects without path tags appear under **Ungrouped**.
If no loaded project has a path tag, the list stays flat.

- Select a namespace name or **Show all X** to open the namespace.
- Select the chevron to collapse or expand a namespace section.
- Use the breadcrumb to return to a parent namespace or **All projects**.
- Turn off **Group by namespace** for a flat list. Your browser remembers this choice.
  The toggle appears only when at least one loaded project has a path tag, even if a search filter hides that project.

Projects tagged exactly with the current namespace appear before its child namespaces.
The browser loads all results before it shows the namespaces.

## Set project tags

Project managers can edit tags in **Edit Project → Tags**.
Press Enter or comma to add a tag. Select a tag and press Backspace or Delete to remove it.
The input trims new tags and ignores empty values. Ordinary tags remain valid.

```bash
mohub projects update --pid <PROJECT_ID> --tags acme/research/vision --tags shared
mohub projects list --all --tag-namespace acme/research
```

API updates use `PATCH /api/v1/projects/{pid}`:

```json
{ "tags": ["acme/research/vision", "shared"] }
```

## Filter by namespace

`GET /api/v1/projects?tag_namespace=dep1` matches `dep1` and `dep1/team/repo`, but not `dep10` or `dep1-archive`.
The filter matches whole, case-sensitive path segments without wildcards.
It accepts one valid path of up to 256 characters. An empty value applies no filter.
Invalid values return `422 VALIDATION_ERROR`.

A project matches if any tag is in the namespace and all other filters (`status`, exact `tag`, and `q`) match.
Project list responses include tags.

MCP `list_catalog` accepts `project_tag_namespace` for this filter. Its `tag` parameter filters notebook tags.
Notebook list endpoints do not accept `tag_namespace`.

A project or notebook can have up to 50 tags. Each tag has 1 to 256 characters.

## Access by namespace

Tags grant no access. Tags are visible to anyone who can discover the project.
Project membership and access policies determine which projects each user can see.
To grant access to a team, add its [IdP group](./auth.md#idp-groups) as a project member.
To change access for users who are not members, set the project's [default access](./auth.md#default-access-for-non-members).

## Move a notebook to another project

From the project page, open a notebook's menu and select **Move to project…**.
You must be a project manager or admin in both projects.
API token scopes and security labels also apply.

Before you move a notebook:

- Stop its sessions and wait for running jobs and sandbox cleanup to finish.
- Complete or cancel uploads, and wait for preview preparation to finish.
- If the source project has security labels, the destination project or the notebook must keep at least the same restrictions.

The notebook keeps its ID, content, versions, thumbnails, proposals, jobs, run history, outputs, and prepared previews.
[App links](./apps.md#authenticated-app-links) follow the notebook. Old notebook URLs return 404.
Members of the destination project can then read the notebook's run logs and outputs.

Other items stay in the source project or do not move:

- Sessions, chat conversations, alerts, and existing audit events stay in the source project.
- The destination project's integrations, credentials, and membership apply.
- Filesystem caches are reclaimed.

A Git-synced notebook keeps its sync configuration and history.
It must pass the destination's [repository policy](./syncing.md#repository-project-policies).
A pull source also needs checkout support and branch access in the destination.
A push source needs a new sync token. After the move, [rotate the token](./syncing.md#rotating-the-sync-token) and update CI with the new sync URL and token.

While the move runs, the notebook is unavailable in both projects, and opening it returns `409 MOVE_IN_PROGRESS`.
The project list shows a **Moving** badge on the notebook.
From the notebook's menu, managers can choose **Resume move** or **Cancel move**.

- **Resume:** If a move stops before it finishes, choose **Resume move** or repeat the move request.
  After the move publishes, the destination serves the notebook; resume to finish the cleanup.
- **Cancel:** Until the move publishes, choose **Cancel move**, run
  `mohub notebooks move cancel --pid <PROJECT_ID> --nid <NOTEBOOK_ID>`,
  or call `DELETE /api/v1/projects/{pid}/notebooks/{nid}/move`.
  Cancellation removes the destination copies and restores the notebook in the source project.

The [API reference](./api.md) lists the move routes.
