# Search

Find notebook metadata, saved code and outputs, data sources, namespaces, tables, and columns through the web app, REST API, or MCP.
Private chat search is not yet available.

## Enable search

Search defaults to `off`. Set `MARIMOHUB_SEARCH_BACKEND=bucket` and run one server replica with `MARIMOHUB_RUN_MAINTENANCE=true` to maintain the index.
Keyword search needs no AI provider.

For semantic notebook search, configure an embeddings endpoint and model:

```sh
MARIMOHUB_SEARCH_BACKEND=bucket
MARIMOHUB_SEARCH_EMBEDDING_URL=https://provider.example/v1/embeddings
MARIMOHUB_SEARCH_EMBEDDING_MODEL=your-embedding-model
MARIMOHUB_SEARCH_EMBEDDING_API_KEY=your-provider-key
```

The API key is optional and requires an HTTPS endpoint. Local HTTP endpoints work without a key.
Enabling embeddings permits sending notebook text to that endpoint.
Integration configuration and credentials are excluded. Provider failures retain keyword search and report incomplete coverage.

When changing embedding or catalog discovery settings, increase `MARIMOHUB_SEARCH_BUILD_REVISION` (default `1`).
Use the same revision and settings on all indexing replicas. Do not decrease the revision during rollback.
See [configuration](./configuration.md#search) for available settings.

### Local embeddings with Ollama

[Ollama](https://docs.ollama.com/capabilities/embeddings) runs embedding models locally:

```sh
ollama pull embeddinggemma
```

Configure the server with an Ollama hostname it can reach:

```sh
MARIMOHUB_SEARCH_EMBEDDING_URL=http://localhost:11434/v1/embeddings
MARIMOHUB_SEARCH_EMBEDDING_MODEL=embeddinggemma
```

No API key is required.

## Search in the web app

Open **Search** above the project picker for all projects, or **Search project** for the current project.
Use **Scope** and **Type** to narrow results. Changing scope preserves the query and type filter.
Both menus support arrow keys, typeahead, and **Escape**. URLs preserve these choices:

- `/search?q=revenue`
- `/projects/{pid}/search?q=revenue&kind=code`

<figure class="doc-screenshot">
  <a href="/screenshots/search-desktop.png" target="_blank" rel="noreferrer" aria-label="Open full-size screenshot: Global search showing notebook and saved-code results with highlighted matches (new tab)">
    <img src="/screenshots/search-desktop.png" alt="Global search showing notebook and saved-code results with highlighted matches" width="1200" height="720" loading="lazy" decoding="async" />
  </a>
  <figcaption>Results include the project, resource type, and a highlighted snippet.</figcaption>
</figure>

**Cmd+K** (macOS) or **Ctrl+K** opens global search. On a search page, it focuses the current field.
**/** focuses the field outside text inputs and selectors. Use **↑/↓** to navigate results, **Enter** to open, and **Escape** to return.

<figure class="doc-screenshot">
  <a href="/screenshots/search-filters.png" target="_blank" rel="noreferrer" aria-label="Open full-size screenshot: Search Type menu with notebook, code, output, data source, and namespace options (new tab)">
    <img src="/screenshots/search-filters.png" alt="Search Type menu with notebook, code, output, data source, and namespace options" width="1200" height="720" loading="lazy" decoding="async" />
  </a>
  <figcaption>Use Scope and Type to narrow the results.</figcaption>
</figure>

Search runs after a 500 ms typing pause. Press **Enter** in the field or click **Search** to submit immediately.
If semantic search is enabled, select **Include related notebook content** for related matches.

Results show up to 50 matches with the project, resource type, and a highlighted snippet.
Data source results open project Integrations. Namespace, table, and column results open the data browser.

<figure class="doc-screenshot doc-screenshot--portrait">
  <a href="/screenshots/search-mobile.png" target="_blank" rel="noreferrer" aria-label="Open full-size screenshot: Mobile search with stacked Scope and Type controls above notebook and code results (new tab)">
    <img src="/screenshots/search-mobile.png" alt="Mobile search with stacked Scope and Type controls above notebook and code results" width="390" height="844" loading="lazy" decoding="async" />
  </a>
  <figcaption>The same search controls and results adapt to narrow screens.</figcaption>
</figure>

## REST and MCP

```http
GET /api/v1/search?q=revenue&project_id=proj-0123456789abcdef&kinds=notebook,code,table&limit=20
```

The MCP tool `search_workspace` accepts the same fields, with `kinds` as an array:

```json
{
	"q": "revenue",
	"project_id": "proj-0123456789abcdef",
	"kinds": ["notebook", "code", "table"],
	"limit": 20,
	"mode": "keyword"
}
```

Omit `project_id` to search across projects. Set `mode` to `hybrid` to include semantic matches when enabled.
Queries contain 1–256 characters. `limit` ranges from 1 to 50.

Results include a typed resource reference, relative link, index timestamp, score, and plain-text snippet.
Highlights use UTF-16 offsets. Render snippets as text, never HTML.
Preserve response order. Scores are not comparable across queries, projects, or sources and must not serve as numeric thresholds.

## Access, freshness, and coverage

Search returns only content the caller can currently access. Data search also requires permission to use the integration.
Search excludes integration credentials and table rows. Saved outputs include plain text and visible HTML text, excluding hidden or external content.

Indexes update asynchronously. New or changed content can remain absent until indexing completes.
`not_indexed` means no index is available. `stale` means the index is older than 15 minutes.
Persistent storage failures or slow reads can prevent updates indefinitely. Existing results remain subject to current access and content checks.

A coverage notice, or `partial: true` in the API, means the search was incomplete.
Per-source status identifies failures, timeouts, missing or stale indexes, disabled sources, and exhausted limits.
An empty result with incomplete coverage does not mean the content is absent.
The `chat` filter reports `disabled` until private chat search is available.

Global search examines at most 16 projects and can omit projects you can access. Select a project or set `project_id` for project-scoped search.
Large projects and catalogs can also have incomplete coverage.
Keyword search matches whole tokens, including underscores, without case sensitivity. It does not match prefixes, substrings, or word variants.
