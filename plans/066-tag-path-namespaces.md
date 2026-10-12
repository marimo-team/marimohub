# Plan 066: Tag paths as project namespaces (`tag_prefix` filter + grouped project list)

> From GitHub issue marimo-team/marimohub#456: a large org wants to structure
> hundreds of projects as org → department → team → repo, with inherited
> membership and IaC provisioning. The chosen direction is split across plans
> 066–071 and adds **no nested project entity**:
>
> - **066 (this plan)**: tag paths as namespaces, a `tag_prefix` list filter, and a grouped project list.
> - **067**: carry a bounded set of IdP group ids in the session.
> - **068**: groups as project-member principals.
> - **069**: config-driven deployment access rules that bind groups to roles on
>   tag prefixes or project ids. 069 reuses this plan's `tag_prefix` semantics
>   exactly, so the semantics are defined once here (§ "Prefix semantics") and
>   live in one pure core helper.
> - **070**: provisioning ergonomics (service-account `project.manage`, `external_id` upsert,
>   `mohub projects apply`, repo-rule globs).
> - **071**: project-list scale hygiene.
>
> This plan is the substrate: a namespace is just a project tag such as
> `research/vision/segmentation`. A project can live in several namespaces.

## Status

- **Priority**: P2 (enterprise organization; prerequisite for 069)
- **Effort**: S–M
- **Risk**: LOW–MED. The API changes are additive (a new query param and a new
  response field). The web list changes from first-page-only to all pages,
  and gains grouping. The MED part: 069 will make tag prefixes grant access,
  so this plan's matching rules must be exact and fail closed.
- **Depends on**: — (plan 032 list filters are shipped; this plan extends them)
- **Blocks**: 069 (consumes `tagMatchesPrefix` / `isPathTag`), 071 (builds on the all-pages list)
- **Category**: feature / API / web
- **Planned at**: 2026-10-07

## Current state (verified 2026-10-07)

- **Tags are free-form today.** `CreateProjectBody.tags` / `UpdateProjectBody.tags`
  are `z.array(z.string())` (`packages/api/src/routes/projects.ts:64-82`).
  `ProjectSchema.tags` is `z.array(z.string())` (`packages/core/src/schema.ts:439`).
  Nothing validates, normalizes, lowercases, or trims tags. Changing tags needs
  `project.update`, which needs the **manager** role
  (`packages/core/src/services/authorization/actions.ts:136`). The route checks
  it at `projects.ts:414`.
- **Snapshot projection.** `SnapshotProjectEntrySchema.tags` is
  `z.array(z.string()).optional()` (`packages/core/src/schema.ts:248`).
  Entries written before tags existed in the snapshot omit it. Every routine
  projection writes it again through `projectCatalogPatch`
  (`packages/core/src/services/content/catalogProjection.ts:79-88`), so a legacy
  entry heals on its next project write.
- **List filters (plan 032).**
  - Query: `ListFilterQuery = { tag, q }` (`packages/api/src/pagination.ts:39-56`).
    It is spread into both `ProjectListQuery` (`:58-68`) and `NotebookListQuery` (`:70-80`).
  - Predicate: `createListFilter(filter, searchableFields, { allowUnknownTags })`
    (`packages/core/src/services/content/listFilters.ts:12-25`). `tag` is an exact,
    case-sensitive match. Tests confirm `tag=Finance` misses `finance`
    (`packages/api/src/routes/projects.test.ts:~120-130`).
  - Projects: `ProjectService.listProjects`
    (`packages/core/src/services/content/ProjectService.ts:224-284`) filters
    snapshot entries with `allowUnknownTags: true` (`:249-254`). It then resolves
    a legacy entry (no `tags`) against `project.json` through the per-call
    `loadProject` memo (`:241-248`, `:256-265`). Authorization filtering
    (`:267-283`) runs **before** pagination, so hidden projects never affect
    cursors.
- **The list response hides tags.** `toPublicProjectEntry` (`packages/core/src/schema.ts:336-347`)
  is an explicit pick that leaves `tags` out, and the comment at `:300-305`
  calls tags a "server-side filtering aid". The API response schema
  `SnapshotProjectEntrySchema` (`packages/api/src/shared.ts:1162-1176`) has no
  `tags` field. Two tests lock this in:
  - `packages/api/src/schema-conformance.test.ts:133-146` lists `'tags'` in `internal`.
  - `packages/api/src/routes/projects.test.ts:56` asserts
    `expect(tagged[0]).not.toHaveProperty('tags')`.

  The **detail** response (`ProjectResponseSchema` through `toPublicProject`) already
  includes `tags`.
- **Route.** The `GET /projects` handler is at `packages/api/src/routes/projects.ts:362-379`.
  It passes `status`, `tag`, and `q` to `listProjects`, then calls `paginate(...)`.
- **MCP.** `list_catalog` (`packages/api/src/mcp/server.ts:65-138`) has a `tag`
  input, but it filters **notebooks** (`:99`), not projects. Projects come from
  `listProjects` without filters (`:88-92`) or from `resolveProject` (`:87`),
  which returns the full `Project`. The output project objects (`:108-111`)
  carry `id`, `name`, and `notebooks` only.
- **Other `listProjects` callers** (they are not changed, but they get the new
  field): `packages/api/src/mcp/selectors.ts:46`,
  `packages/api/src/routes/apps.ts:100`, `apps/server/src/devSetup.ts:290`.
- **Web.**
  - `useProjectsQuery` (`packages/web/src/api/hooks.ts:416-434`) fetches **one
    page** (the default `limit` is 100, `DEFAULT_PAGE_SIZE` at `pagination.ts:18`)
    and returns `.items`. It has two callers:
    `components/ProjectList/ProjectList.tsx:47` and
    `components/Account/TokenGrantEditor.tsx:60` (q-filtered picker).
  - `useProjectPickerQuery` (`hooks.ts:881-895`) already walks every page with
    `listAllCursorPages` (`hooks.ts:695-712`), using `limit: 500` and a
    repeated-cursor guard.
  - Query keys: `projectKeys.filteredList(filters)`
    (`packages/web/src/api/queryKeys.ts:29`), typed by `ListQueryFilters { q, status, tag }` (`:10-14`).
  - Types: `ProjectSummary = SnapshotProjectEntry` and
    `ProjectListFilters = Pick<ProjectListQuery, 'q' | 'status' | 'tag'>`
    (`packages/web/src/types/index.ts:51-53`). Both are generated from
    `@marimo-hub/client`.
  - Filters: `packages/web/src/lib/listFilters.ts` (`ListFilterValues`,
    `readListFilters`, `updateListFilterParams`, `hasListFilters`),
    `packages/web/src/hooks/useListFilters.ts`, and
    `packages/web/src/components/ui/ListFilters.tsx`. The form `onSubmit`
    (`:107-115`) rebuilds values from `q`, `tag`, and `status` **only**, so any
    other key is dropped on Apply. The same component and hook also serve the
    notebook list in `components/Project/Project.tsx:253` and `:803`.
  - `ProjectRow` (`ProjectList.tsx:149-194`) renders no tags.
    `NotebookTags` (`components/Project/NotebookTags.tsx`, 48 lines) is a
    generic tag strip: two chips, then a popover.
  - The Edit Project dialog (`Project.tsx:346-367`, `:1205-1220`) edits only
    name and description. **The UI has no way to set project tags today**;
    they can be set only through the API, CLI, or MCP.
  - `ProjectList.test.tsx` already builds fixtures typed
    `ProjectSummary & { tags: string[] }`, with a fetch stub that filters by
    `tag` (`:16-58`).
- **Codegen.** Root `pnpm schemas:generate` (`package.json:26`) runs these in order:
  1. api `openapi:generate` (rewrites `packages/api/openapi.yaml`).
  2. api `cli:generate` (rewrites `apps/cli/generated/cli-manifest.json`).
     `cliName` maps `tag_prefix` to `tag-prefix` (`packages/api/src/cliManifest.ts:120-121`).
  3. core `schemas:generate`.
  4. client `generate` (rewrites `packages/client/src/schema.ts`).
  5. docs integrations.

  The Rust CLI embeds the manifest at build time (`apps/cli/src/manifest.rs:80`).
  oasdiff runs in `.github/workflows/schemas.yml:48-80`. A new optional query
  param and a new response property are non-breaking.
- **Validation errors** from zod request schemas return **422**
  `VALIDATION_ERROR` (`packages/api/src/shared.ts:752-768`). `commonErrors()`
  already declares 422 (`:1052-1054`).
- **Precedent for a shared grammar.** `packages/core/src/deepLinkSlug.ts`
  defines the slash-separated slug regex. It is exported as the subpath
  `@marimo-hub/core/deep-link-slug`, and web imports core subpaths the same way
  (for example `@marimo-hub/core/token-grants`).
- **Docs.** `docs/api.md:62-66` has the Projects bullet. `docs/mcp.md:63` has the
  `list_catalog` row. `docs/cli.md:148-168` has the `mohub projects list`
  examples. Two lists in `apps/docs/.vitepress/config.mts` must include each
  docs page: `nav` (`:95-155`, including the Configure `activeMatch` regex at `:104`)
  and `sidebar` (`:157+`). `apps/docs/.vitepress/docs-structure.test.ts:87-92`
  enforces this.

## Design

### 1. The path-tag convention

A **path tag** is a project tag that matches the full string

```
^[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)*$
```

Segments are separated by `/`. Each segment starts with a lowercase
alphanumeric character. A project can carry any number of path tags, and other
free-form tags alongside them. Examples:
- `research` and `research/vision/segmentation` are path tags.
- `Research`, `research/`, `/research`, `research//x`, and `team a` are **not**
  path tags. They are still valid free-form tags.

**Decision: interpret on read. Do not validate or normalize at write time.**
Tags stay `z.array(z.string())` on create and update.

Why:

1. **Compatibility.** Existing stored tags are arbitrary strings. Tightening the
   request schema is a breaking change for oasdiff (it adds a request-property
   pattern). Every update that sends back an existing non-conforming tag would
   then fail, including the web Edit dialog added in Step 7.
2. **Notebook tags share the free-form contract.** They are ad-hoc labels, not
   namespaces. Two grammars for one `tags` field would confuse users.
3. **Normalizing silently changes data.** Lowercasing or trimming would break
   exact `tag=` matches that clients rely on today (plan 032 made `tag`
   case-sensitive on purpose).
4. **Fail-closed for 069.** A tag that only looks like a path (`Research/Vision`)
   does not match a prefix. A typo then hides a project from a group rule
   instead of granting something unintended. The UI shows a non-blocking hint
   for near-misses (Step 7).

One pure helper module defines the grammar and matching rules. API filtering,
MCP, the web grouping, and plan 069 all import it, so the rules cannot drift.

### 2. Prefix semantics (normative; 069 depends on this)

Core module `packages/core/src/tagPaths.ts` (new). It has no zod and no I/O.
Export it as the subpath `"./tag-paths": "./src/tagPaths.ts"` in
`packages/core/package.json` and re-export it from `packages/core/src/index.ts`.

```ts
export const PATH_TAG_PATTERN = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*(?![\s\S])/;
export const MAX_TAG_PREFIX_LENGTH = 256;
export function isPathTag(tag: string): boolean;
/** `prefix` must itself be a path tag; otherwise returns false. */
export function tagMatchesPrefix(tag: string, prefix: string): boolean;
export function tagsMatchPrefix(tags: readonly string[], prefix: string): boolean;
/** First segment beneath `prefix` (or the first segment when prefix is undefined); undefined when `tag` is not a path tag under it or equals it. */
export function childSegment(tag: string, prefix?: string): string | undefined;
```

Use `(?![\s\S])` as the end anchor, as `deepLinkSlug.ts` does, instead of `$`.

`tagMatchesPrefix(tag, prefix)` is true **if and only if** all of these hold:
- `isPathTag(prefix)` is true.
- `isPathTag(tag)` is true.
- `tag === prefix` or `tag.startsWith(prefix + '/')`.

So:
- `tag_prefix=dep1` matches `dep1` and `dep1/team-a/repo`.
- It does **not** match `dep10`, `dep1-archive`, `Dep1`, or `dep1/Team A`
  (the last is not a path tag).
- Matching is case-sensitive and segment-aligned.
- There are no wildcards. A trailing `/` is not accepted.

On the list endpoint:
- `tag_prefix` is **single-valued**.
- It ANDs with `status`, `tag`, and `q`.
- A project matches when **any** of its tags matches.
- An invalid value returns **422 VALIDATION_ERROR**. Invalid means empty,
  longer than 256 characters, or not a path tag.
  - This is different from `q=` (empty means unfiltered). An empty prefix has
    no meaning, and silently treating it as "everything" is the wrong failure
    for a value that 069 will reuse as an access selector.
  - Implement it in zod as
    `z.string().max(MAX_TAG_PREFIX_LENGTH).regex(PATH_TAG_PATTERN).optional()`.
- Legacy snapshot entries without `tags` are resolved against `project.json`
  through the existing `loadProject` memo, exactly like `tag`.

### 3. Scope: projects only

`tag_prefix` is added to **`ProjectListQuery` only**, not to the shared
`ListFilterQuery`. Namespaces are a project-level concept, and 069 binds roles
to projects. Notebook tags are labels inside a project. Exposing
`notebooks list --tag-prefix` would add CLI surface for a meaning nobody asked
for.

The predicate still lives in the shared `createListFilter` (as an optional
`tagPrefix` on `ListFilters`), so one function owns all tag-matching logic.
`NotebookService.listNotebooks` simply never receives a `tagPrefix` from any
route. Adding it later is a one-line route change.

### 4. Tags in the project list response

- Add `tags: string[]` (required) to `PublicProjectEntry` and
  `toPublicProjectEntry` in core, and to the API `SnapshotProjectEntrySchema`.
- Legacy entries without snapshot `tags`: after authorization filtering,
  `listProjects` fills `tags` from `project.json` through the same `loadProject`
  memo. A missing head (`NotFoundError`) gives `[]`. This never returns a
  made-up `[]` for a project that has tags.
- The extra reads are bounded by the number of visible legacy entries. They
  disappear as entries heal on their next write. A one-shot backfill is listed
  under Follow-ups.
- Adding a response property is non-breaking for oasdiff. The generated client
  type becomes stricter, which is good: web fixtures must add `tags`.

### 5. Web: all pages, tags on rows, grouping

- **Fetch all pages.** Change `useProjectsQuery` to walk every page with
  `listAllCursorPages`, sending `limit: 500` **and the same filters on every
  page**.
  - Client-side grouping needs the complete filtered set. Infinite scroll would
    render partial groups with wrong counts. This also fixes the current silent
    truncation at 100 projects.
  - `TokenGrantEditor` gets the same behavior; it is q-filtered and fine.
  - Plan 071 owns very large rosters (for example virtualization or a server cap).
- **Tags on rows.** `ProjectRow` renders
  `<NotebookTags tags={project.tags} title={project.name} />` before the
  notebook-count pill. Reuse the component as it is. Rename it only if it stays
  a one-line import change; the default is not to rename.
- **Grouping is pure and client-side.** Add
  `packages/web/src/lib/projectGroups.ts`:

  ```ts
  interface ProjectGroup<P> { prefix: string; label: string; projects: P[] }
  interface GroupedProjects<P> { groups: ProjectGroup<P>[]; direct: P[]; ungrouped: P[] }
  export function groupProjectsByTagPath<P extends { tags: string[] }>(
  	projects: readonly P[], prefix?: string,
  ): GroupedProjects<P>;
  ```

  - **No active prefix.** The group key is `childSegment(tag)`, which is the
    first segment of each path tag. A project with path tags in `dep1` and
    `dep2` appears in **both** groups, at most once per group. Projects with no
    path tags go to `ungrouped`.
  - **Active prefix `P`.** The group key is `P + '/' + childSegment(tag, P)` for
    each tag where `tagMatchesPrefix(tag, P)` and `tag !== P`. Projects tagged
    exactly `P` go to `direct`. Nothing is ungrouped, because the server
    already filtered by `P`.
  - Groups are sorted by `prefix` with `localeCompare`. Projects inside a group
    keep server order (newest first).
  - When `groups` is empty and there is no prefix, render the flat list exactly
    as today, with no section chrome. Small deployments see no change.
- **Sections.** Each group is a `<section aria-labelledby>` inside a
  `ListContainer` stack. The header has two separate controls:
  - A chevron `Button` with `aria-expanded` toggles collapse. The collapsed
    state is a local `useState<Set<string>>` and is not persisted.
  - A label `Button` ("research · 12") sets `tag_prefix` to the group's
    `prefix`. This is the drill-down.

  Order: `direct` first (label "Tagged {P}"), then the groups, then
  "Ungrouped" last.
- **Breadcrumb.** When `tag_prefix` is active, show a breadcrumb above the list:
  "All projects / research / vision". Each segment pops to that prefix, and
  "All projects" clears it.
- **Result count.** `ListFilters` `resultCount` and `ListResults` `count` stay the
  **unique** project count.
- **Filter plumbing.**
  - Add `tag_prefix?: string` to `ListFilterValues`.
  - `readListFilters(params, statuses, { tagPrefix = false } = {})` reads
    `tag_prefix` only when enabled, so the notebook page never forwards a stray
    URL param to the notebooks endpoint.
  - `updateListFilterParams` handles `q`, `status`, `tag`, and `tag_prefix`.
  - `hasListFilters` includes `tag_prefix`.
  - `useListFilters(statuses, options?)` forwards the option. `ProjectList`
    passes `{ tagPrefix: true }`.
  - `ListFilters.tsx` must keep `values.tag_prefix` on Apply. Spread it into the
    `onChange` payload and add it to the form `key`. The filter panel gets no
    tag-path text field; the group headers and the breadcrumb drive it. Reset
    still clears everything.

Rejected:

- **A nested project entity (project → sub-project / folder tree).** It needs:
  - a new CAS-managed record type with an owner (see the CLAUDE.md invariant list),
  - move and rename semantics,
  - cycle checks,
  - inherited-ACL evaluation on every authz check,
  - recursive deletion that interacts with app-pool tombstones and preview
    records,
  - a migration of every `projects/{pid}` path assumption.

  Tags already exist, are already projected into the snapshot, are already
  filterable, and allow multi-membership, which a tree cannot express (a repo
  shared by two teams). The issue's needs are browse, scope, and inherit-access.
  066 covers browse and scope. 068 and 069 cover access without a tree.
- **A separate `namespace` field on the project.** This means a second
  single-valued string, with a schema change in `project.json`, the snapshot
  entry, the API, the CLI, and the web. It also forces exactly one namespace
  per project. It adds nothing over a path tag except uniqueness, and that
  uniqueness is the wrong constraint for shared repos.
- **A server-side groups endpoint (`GET /project-groups`).** The snapshot is a
  single object that is already loaded for every list. The list (now with
  `tags`) is all the client needs to group. A groups endpoint would have to
  repeat authorization filtering, label filtering, and legacy-tag fallback, and
  it would add a cache-coherence surface. Revisit in 071 only if rosters outgrow
  client-side grouping.
- **Write-time validation or normalization of path tags.** See § 1. This is
  rejected for compatibility and to keep 069 fail-closed.
- **`tag_prefix` on the notebook list.** See § 3. It can be added later with no
  break.
- **Prefix match on raw strings (`startsWith(prefix)`).** It would match `dep10`
  for `dep1`. Segment alignment is mandatory.

## Steps

1. **Core: grammar helpers.**
   - Create `packages/core/src/tagPaths.ts` with the exports in § 2.
   - Add `"./tag-paths": "./src/tagPaths.ts"` to the `exports` of
     `packages/core/package.json` (next to `./surface-state`; the map is not strictly sorted).
   - Re-export it from `packages/core/src/index.ts`.
   - Add a colocated `packages/core/src/tagPaths.test.ts` that is table-driven
     over these cases:
     - Valid: `a`, `a/b`, `a.b_c-d/e1`.
     - Invalid: `''`, `A`, `a/`, `/a`, `a//b`, `-a`, `a b`, `a\n`, `a/B`.
     - `tagMatchesPrefix`: `dep1` vs `dep1`, `dep1/x`, `dep10`, `dep1-x`,
       `Dep1`, and `dep1/Team A`. An invalid prefix always gives false.
     - `childSegment` with and without a prefix.
2. **Core: filter predicate.** In `packages/core/src/services/content/listFilters.ts`:
   - Add `tagPrefix?: string` to `ListFilters`.
   - Extract `export function tagsMatchFilters(tags: readonly string[], filter: Pick<ListFilters<string>, 'tag' | 'tagPrefix'>): boolean`.
     It is true when (`tag` is undefined or `tags.includes(tag)`) AND
     (`tagPrefix` is undefined or `tagsMatchPrefix(tags, tagPrefix)`).
   - In `createListFilter`, use it for known tags. Keep the
     `entry.tags === undefined && allowUnknownTags` escape hatch for the case
     where either tag filter is set.
3. **Core: `ProjectService.listProjects`** (`ProjectService.ts:224-284`).
   - Generalize the legacy block at `:256-265` to run when `filter?.tag` **or**
     `filter?.tagPrefix` is defined. Use
     `tagsMatchFilters(project.tags ?? (await loadProject(project.id)).tags, filter)`.
   - Fill tags for the response: map every returned entry through a helper that
     resolves `entry.tags ?? (await loadProject(entry.id)).tags`. Use
     `mapWithConcurrency(..., BUCKET_SCAN_CONCURRENCY, ...)` and map
     `NotFoundError` to `[]`.
   - Do this on both return paths (`:266` with no authz and `:276-283` after
     label filtering), so authz runs first and hidden projects cost no reads.
   - Then, in `packages/core/src/schema.ts`:
     - Add `'tags'` to the `PublicProjectEntry` pick (`:306-315`).
     - Make `toPublicProjectEntry` take an entry with
       `tags: string[]` guaranteed. The suggested signature is
       `(entry: SnapshotProjectEntry & { tags: string[] })`.
     - Update the comment at `:300-305`: tags are now public; `member_ids`,
       `member_emails`, and labels stay internal.
   - Tests in `ProjectService.test.ts` (next to the existing legacy-tag test at `:264-284`):
     - `tagPrefix` matching and non-matching cases, including `dep10`.
     - AND with `tag` and `q`.
     - A legacy entry with no snapshot tags matches through `project.json`, and
       its tags show up in the result.
     - A legacy entry still costs exactly **one** `project.json` read for role,
       tags, and labels together. Extend the existing `get` spy assertion.
     - A hidden project triggers no tag read.
4. **API: query + response.**
   - `packages/api/src/pagination.ts`: add `tag_prefix` to `ProjectListQuery`
     only (`:58-68`). Leave `ListFilterQuery` and `NotebookListQuery` unchanged:

     ```ts
     tag_prefix: z.string().max(MAX_TAG_PREFIX_LENGTH).regex(PATH_TAG_PATTERN).optional().openapi({
     	param: { name: 'tag_prefix', in: 'query' },
     	description: 'Path-tag namespace. Matches projects with a tag equal to this value or nested under it (`a` matches `a` and `a/b`, not `ab`). Lowercase segments of [a-z0-9._-] separated by `/`.',
     	example: 'research/vision',
     }),
     ```

     Import the constants from `@marimo-hub/core`.
   - `packages/api/src/routes/projects.ts:366-373`: pass
     `tagPrefix: query.tag_prefix` to `listProjects`.
   - `packages/api/src/shared.ts:1162-1176`: add
     `tags: z.array(z.string()).openapi({ example: ['research/vision'] })` to
     `SnapshotProjectEntrySchema`. Keep the field order the same as core's pick
     (after `updated_at`, before `notebook_count`, or match whatever order the
     conformance test's `shapeKeys` comparison needs).
   - `packages/api/src/schema-conformance.test.ts:136-143`: remove `'tags'` from
     `internal` and update the comment above it (`:129-132`).
   - `packages/api/src/routes/projects.test.ts`:
     - Flip `:56` to `expect(tagged[0].tags).toEqual(['finance'])`.
     - Add `tag_prefix` cases: segment alignment (`dep1` vs `dep10`), AND with
       `tag`/`q`, and pagination of the prefixed set with `limit=2` plus the
       cursor.
     - Add a 422 for `tag_prefix=`, `tag_prefix=Dep1`, `tag_prefix=dep1/`, and
       a 257-character value.
     - Extend the legacy test (`:104-119`) to assert that `tags: ['legacy']` is
       returned.
5. **MCP `list_catalog`** (`packages/api/src/mcp/server.ts:65-138`).
   - Add the input
     `project_tag_prefix: z.string().max(MAX_TAG_PREFIX_LENGTH).regex(PATH_TAG_PATTERN).optional().describe('Only projects with a path tag equal to or nested under this namespace.')`.
     It is named apart from `tag`, which keeps filtering notebooks.
   - Without `project`: pass `tagPrefix` to `listProjects`.
   - With `project`: after `resolveProject`, keep the project only if
     `tagsMatchPrefix(project.tags, prefix)`. Otherwise return `projects: []`
     rather than an error.
   - Add `tags` to each output project object (`:108-111`).
   - Update the tool description.
   - Add a test in `packages/api/src/mcp/server.test.ts` that covers both branches.
6. **Regenerate specs + CLI.**
   - Run `pnpm schemas:generate`. It rewrites `packages/api/openapi.yaml`,
     `apps/cli/generated/cli-manifest.json` (the `projects list` entry at
     `~:4621` gains `{"name": "tag_prefix", "cli_name": "tag-prefix", ...}`),
     and `packages/client/src/schema.ts`.
   - Commit all three. The drift tests (`openapi.spec`, `cliManifest.spec`,
     `client schema.drift`) must pass.
   - Confirm that `mohub projects list --tag-prefix research --all` parses. If
     the Rust toolchain is present, run
     `cargo test --manifest-path apps/cli/Cargo.toml`.
7. **Web.**
   1. `packages/web/src/types/index.ts:53`: change to
      `Pick<ProjectListQuery, 'q' | 'status' | 'tag' | 'tag_prefix'>`.
      `packages/web/src/api/queryKeys.ts:10-14`: add `tag_prefix?: string` to
      `ListQueryFilters`.
   2. `packages/web/src/api/hooks.ts:416-434`: change `useProjectsQuery`'s
      `queryFn` to
      `listAllCursorPages((cursor) => apiData(apiClient.GET('/api/v1/projects', { params: { query: { ...filters, limit: 500, ...(cursor ? { cursor } : {}) } } })), 'Project listing did not advance; refusing a partial roster.')`.
      Keep `placeholderData: keepPreviousData` and the options. Update the
      `useProjectPickerQuery` doc comment (`:873-879`), which says "unlike the
      first-page home list".
   3. `packages/web/src/lib/listFilters.ts` + `hooks/useListFilters.ts` +
      `components/ui/ListFilters.tsx`: make the `tag_prefix` plumbing changes
      from § 5.
   4. Create `packages/web/src/lib/projectGroups.ts`. It imports
      `childSegment` and `tagMatchesPrefix` from `@marimo-hub/core/tag-paths`.
   5. `components/ProjectList/ProjectList.tsx`:
      - Add the tags on rows, the grouped sections, the breadcrumb, and the
        header buttons that set `tag_prefix` through
        `setFilters({ ...filters, tag_prefix })`.
      - Put the section and breadcrumb into small local components in the same
        file, or into `components/ProjectList/ProjectGroups.tsx` if
        `ProjectList.tsx` grows past about 300 lines.
      - Use Tailwind utilities and existing `components/ui` primitives
        (`Button`, `ListContainer`). Do not add new CSS.
   6. **Edit Project tags field** (`components/Project/Project.tsx:231-234`,
      `:346-367`, `:1214-1219`):
      - Add a `tags` text field. It holds comma-separated values; split, trim,
        and drop empty values on submit.
      - Seed it from `project.tags.join(', ')` and send `tags` in
        `updateProject.mutateAsync`.
      - Show a non-blocking description for near-misses: any tag that contains
        `/` but fails `isPathTag` gets "won't be treated as a namespace (use
        lowercase segments like `team/repo`)".
      - Do **not** block submit.
      - This is the only UI path for setting namespaces, so it is in scope. It
        is still a separate commit.
   7. Tests (vitest + jsdom; setup in `packages/web/src/test/setup.ts`):
      - `lib/projectGroups.test.ts`:
        - No path tags gives only ungrouped.
        - A project in two groups.
        - The `direct` bucket under a prefix.
        - Sort order.
        - `dep10` stays out of `dep1`.
      - `lib/listFilters.test.ts`: `tag_prefix` is read only when enabled; it
        round-trips through `updateListFilterParams`; `hasListFilters`.
      - `components/ui/ListFilters.test.tsx`: Apply keeps `tag_prefix`.
      - `components/ProjectList/ProjectList.test.tsx` (extend the fetch stub at
        `:42-58` to honor `tag_prefix` and `cursor`):
        - Tags render on rows.
        - Groups render, and the flat list stays when there are no path tags.
        - Clicking a group label sets `?tag_prefix=` and sends it to the API.
        - The breadcrumb pops and clears.
        - Collapse hides rows.
        - A two-page response (the stub returns `next_cursor` once) renders
          projects from both pages, and both requests carry the filters.
      - Update `api/hooks.test.tsx` if it asserts the single-page shape.
      - `Project.test.tsx` (or its testWorld): saving the edit dialog sends `tags`.
8. **Docs.**
   - Create `docs/organizing-projects.md` with the frontmatter
     `description: Organize projects into namespaces with path tags.` It covers:
     - The convention and grammar.
     - Examples for org → department → team → repo.
     - Multi-membership.
     - Why tags and not folders.
     - The `tag_prefix` semantics, with a `dep1`/`dep10` example.
     - The grouped list and drill-down.
     - Setting tags in the web dialog, `mohub projects update --tags`, and the API.
     - A short "Access by namespace" placeholder paragraph that points out tags
       do not grant access yet (068/069).
   - Add the page to `apps/docs/.vitepress/config.mts`:
     - the Configure nav `items`, after "Project alerts";
     - the Configure `activeMatch` regex at `:104` (add `organizing-projects`);
     - the Configure `sidebar` items in the same position.
   - `docs/api.md:62`: say that project list items carry `tags` and that
     `GET /projects` accepts `tag_prefix`, and link the new page.
   - `docs/mcp.md:63`: update the `list_catalog` row to mention
     `project_tag_prefix`.
   - `docs/cli.md` near `:148`: add `mohub projects list --all --tag-prefix research/vision`.
   - Per the docs convention, do not add redirect stubs. Nothing is renamed here.
9. **Review the diff and strip AI-slop comments.**
   - Remove comments that restate code, narrate the change ("now also returns
     tags"), or are doc blocks that are obvious from the signature.
   - Keep the comments that explain *why*: segment alignment, fail-closed for
     069, the legacy `project.json` fallback, and why the notebook page does not
     read `tag_prefix`.
   - Run `pnpm check` after the cleanup.

## Verification

- `pnpm --filter @marimo-hub/core test` (tagPaths, listFilters, ProjectService).
- `pnpm --filter @marimo-hub/api test` (projects routes, schema-conformance, MCP
  server, `openapi.spec`, and `cliManifest.spec` drift).
- `pnpm --filter @marimo-hub/client test` (schema drift).
- `pnpm --filter @marimo-hub/web test`.
- `pnpm --filter @marimo-hub/docs test` (docs structure and content integrity).
- Run `pnpm schemas:generate` again. Afterwards `git status` must show no
  further changes to `packages/api/openapi.yaml`,
  `apps/cli/generated/cli-manifest.json`, or `packages/client/src/schema.ts`.
- Root `pnpm check && pnpm typecheck && pnpm test`.
- Spec gate: the oasdiff changelog (schemas workflow) reports only additions,
  meaning a new optional query param `tag_prefix` and a new response property
  `tags`. No `internal/schemas/allowed-breaking/api.md` entry is needed.
- Manual check in the dev stack:
  1. Create projects tagged `research/vision/seg`, `research/nlp`,
     `research10`, and `ops`, plus one project with no tags.
  2. The list shows the groups `ops`, `research`, and `research10`, plus
     Ungrouped.
  3. Clicking `research` shows the subgroups `research/nlp` and
     `research/vision` and excludes `research10`.
  4. The breadcrumb returns to all projects.
  5. With more than 100 projects, all of them appear.

## STOP conditions

- If `toPublicProjectEntry` or `PublicProjectEntry` turns out to feed a
  persisted record or an audit payload (not only API and MCP responses), STOP
  and report. Adding `tags` must not change stored shapes.
- If filling legacy tags in `listProjects` needs more than one `project.json`
  read per legacy entry per request (meaning the memo is bypassed), STOP and fix
  the memo use. Do not add a cache.
- If oasdiff flags any change as breaking, STOP. Do not add an
  allowed-breaking entry. The design is additive by construction.
- If anyone proposes making `tag_prefix` match non-path tags, raw prefixes, or
  case-insensitively "for convenience", STOP. Plan 069 reuses this predicate as
  an access selector, and loosening it is a security change.
- If walking all pages makes `ProjectList.test.tsx` or the jsdom suite
  materially slower, or a real deployment's roster is large enough that the
  all-pages fetch is noticeably slow, STOP. Keep pagination as it is today and
  hand the problem to plan 071 instead of inventing a server-side group API
  here.
- If the Edit Project tags field causes form-validation problems (see the
  react-aria `validationBehavior="aria"` gotcha in the project memory), split it
  into its own follow-up instead of blocking the rest.

## Follow-ups (out of scope)

- **069**: deployment access rules `{ group, role, tag_prefix | project_id }`.
  They must call `tagMatchesPrefix` from `@marimo-hub/core/tag-paths`. Note for
  069: tag edits need `project.update` (manager). When tags start granting
  access, a manager could move a project into another namespace and widen its
  audience. 069 must decide whether namespace tag changes need extra authority,
  for example a separate `project.retag` action or admin-only edits of path tags.
- **070**: `mohub projects apply` should accept path tags declaratively, and
  `external_id` upsert should set them.
- **071**: virtualization or a server cap for very large rosters, and maybe a
  snapshot-side tag index.
- A one-shot maintenance backfill of snapshot `tags` for legacy entries, so the
  `project.json` fallback can eventually be removed.
- A repeatable `tag_prefix` (OR across namespaces), if real demand appears.
- `tag_prefix` on the notebook list, if notebook-level namespaces are ever wanted.
