---
description: Organize projects into namespaces with path tags.
---

# Organizing projects

A namespace is a project tag such as `acme/research/vision/segmentation`.
The segments can represent an organization, department, team, and repository.
Projects keep their existing IDs and URLs.

## Path tags

A path tag uses lowercase letters, digits, dots, underscores, and hyphens.
Each segment starts with a lowercase letter or digit. A slash separates segments.
The full tag must match this grammar:

```text
[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)*
```

`research`, `research/vision`, and `team-a/repo_1` are path tags.
`Research`, `research/`, `/research`, `research//vision`, and `team a` are ordinary tags.
Tags remain free-form. The API does not trim, normalize, or reject ordinary tags when you create or update projects.

A project can belong to several namespaces. For example, a shared repository can have both `acme/research/vision` and `acme/platform/data`.
Tags support this shared membership without folders, moves, or a separate project tree.

## Browse namespaces

The project list groups projects by the first segment of each path tag by default.
Turn off **Group by tags** for a flat list. Your browser remembers this preference.
A project appears once in each matching group. Projects without path tags appear under **Ungrouped**.
The result count counts each project once, even if it appears in several groups.

Select a group name to browse its child namespaces. Select its chevron to collapse or expand the group.
Each namespace group previews up to five projects. Select **Show all X** to open that namespace.
Projects tagged exactly with the selected namespace appear directly below the breadcrumb, before any child groups.
Use the breadcrumb to return to a parent namespace or **All projects**.

The list loads every page before it shows the groups. If no project has a path tag, the list stays flat.

## Set project tags

Project managers can change tags.

In the web app, open **Edit Project** and enter values in **Tags**.
Press Enter or comma to add each tag. Select a tag and press Backspace or Delete to remove it.
The form trims new values and ignores empty values. It shows a hint for invalid paths but permits ordinary tags.

With the CLI:

```bash
mohub projects update --pid <PROJECT_ID> --tags acme/research/vision --tags shared
mohub projects list --all --tag-prefix acme/research
```

With the API, send a project update to `PATCH /api/v1/projects/{pid}`:

```json
{
	"tags": ["acme/research/vision", "shared"]
}
```

## Filter by namespace

`GET /api/v1/projects?tag_prefix=dep1` matches `dep1` and `dep1/team/repo`.
It does not match `dep10`, `dep1-archive`, `Dep1`, or `dep1/Team A`.
Matching is case-sensitive, uses complete segments, and has no wildcards.

The single `tag_prefix` value must be a valid path tag of at most 256 characters.
An empty or invalid value returns `422 VALIDATION_ERROR`.
A project matches if any tag matches the prefix. The prefix combines with `status`, exact `tag`, and `q` through AND.
Project list items include their tags.

The MCP `list_catalog` tool accepts `project_tag_prefix` for the same project filter.
Its `tag` parameter still filters notebook tags. Notebook list endpoints do not support `tag_prefix`.

## Access by namespace

Tags do not grant access. Project membership and existing access policies still determine which projects each user can see.
Group membership and namespace access rules are planned separately in plans 068 and 069.
