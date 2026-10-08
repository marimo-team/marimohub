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

Projects appear in each matching group by default. The total counts each project once.
Groups preview up to five projects when their namespace fits the 256-character filter limit.
Longer namespaces show all projects without a drill-down link.
Projects without path tags appear under **Ungrouped**.
If no projects have path tags, the list stays flat.

- Select a group name or **Show all X** to open its namespace.
- Select the chevron to collapse or expand a group.
- Use the breadcrumb to return to a parent namespace or **All projects**.
- Turn off **Group by tags** for a flat list. Your browser remembers this choice.

Projects tagged exactly with the current namespace appear before its child groups.
The browser loads all results before it shows the groups.

## Set project tags

Project managers can edit tags in **Edit Project → Tags**.
Press Enter or comma to add a tag. Select a tag and press Backspace or Delete to remove it.
The input trims new tags and ignores empty values. Ordinary tags remain valid.

```bash
mohub projects update --pid <PROJECT_ID> --tags acme/research/vision --tags shared
mohub projects list --all --tag-prefix acme/research
```

API updates use `PATCH /api/v1/projects/{pid}`:

```json
{ "tags": ["acme/research/vision", "shared"] }
```

## Filter by namespace

`GET /api/v1/projects?tag_prefix=dep1` matches `dep1` and `dep1/team/repo`, but not `dep10` or `dep1-archive`.
The filter matches complete, case-sensitive segments without wildcards.
It accepts one valid path of up to 256 characters. Empty or invalid values return `422 VALIDATION_ERROR`.

A project matches if any tag matches the prefix and all other filters (`status`, exact `tag`, and `q`) match.
Project list responses include tags.

MCP `list_catalog` accepts `project_tag_prefix` for this filter. Its `tag` parameter filters notebook tags.
Notebook list endpoints do not accept `tag_prefix`.

## Access by namespace

Tags do not grant access. Project membership and access policies determine which projects each user can see.
