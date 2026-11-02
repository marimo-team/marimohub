# Federated search

Search combines notebook content and integration metadata through one authorized REST/MCP operation.
The bucket backend partitions indexes by project and source. The web app shares one search page across global and project routes. The private chat source remains separate work.
See the [search guide](../docs/search.md) for configuration, requests, screenshots, and user-visible limits.

## Architecture

| Component             | Responsibility                                                  | Implementation                              |
| --------------------- | --------------------------------------------------------------- | ------------------------------------------- |
| `SearchService`       | Authorization, source coordination, ranking, and responses      | `packages/core/src/search/SearchService.ts` |
| `SearchSource`        | Resumable discovery, extraction, and live resource checks       | `packages/core/src/search/contracts.ts`     |
| `SearchRetriever`     | Bounded candidate retrieval, including an optional query vector | `packages/core/src/search/contracts.ts`     |
| `SearchSnapshotStore` | Snapshot ingestion, build claims, and CAS publication           | `packages/core/src/search/contracts.ts`     |
| `SearchIndexer`       | Crawl checkpoints, budgets, embedding reuse, and publication    | `packages/core/src/search/SearchIndexer.ts` |
| `BucketSearchIndex`   | Immutable snapshots, CAS heads, and cached token postings       | `packages/search-bucket/src/index.ts`       |
| `EmbeddingProvider`   | Optional notebook and query embeddings                          | `packages/core/src/search/contracts.ts`     |
| `makeSearch`          | Adapter selection and source registration                       | `packages/config/src/search.ts`             |
| Shared API operation  | REST/MCP validation and invocation                              | `packages/api/src/search/operations.ts`     |

Core owns contracts and policy. Configuration selects concrete adapters, which import focused core exports.
Sources supply notebook metadata/code/outputs and integration names/namespaces/tables/columns.
REST and MCP share authorization, ranking, snippets, highlights, typed references, and links.

Shared utilities define budgets (`limits.ts`), storage keys (`paths.ts`), and embedding checks/deadlines (`embeddings.ts`).
HTML parsing uses `parse5`. Contracts use `zod`.
Query embeddings use `BoundedLruMap`. Snapshots use weighted `lru-cache` entries.

### Extension points

To add a searchable type:

1. Extend hit kinds, resource references, and link construction.
2. Implement `SearchSource.page` with bounded discovery and a resumable cursor.
3. Implement `validate` for both `rank` and `return`, using current resource state and caller authorization.
4. Register the source and test revocation, deletion, freshness, cancellation, and budget exhaustion.
5. Run `pnpm schemas:generate`.

Source IDs must be stable and unique. At most four sources are registered, each supporting multiple hit kinds.
Increase the source revision when cursor formats or extraction rules change.
Include relevant source options in its configuration identity; never include credentials.

A query backend implements `SearchRetriever`; requests include text, kind filters, and an optional query vector with its model identity.
The bucket adapter also implements `SearchSnapshotStore` for the existing crawler.
Its `head` and `claim` operations do not load documents. Only embedding reuse needs the previous snapshot during discovery.
An incremental engine can supply its own ingestion path without implementing whole-corpus replacement.
Design that ingestion port with a concrete backend; preserve revision checks, deletion fences, and bounded retrieval.

## Authorization and ranking

Each query checks project access before index retrieval, then checks project and resource access before ranking.
After selecting the highest-ranked results, it checks resources, content freshness, and project access again.
Every project check rereads current state. Authorization decisions are never cached.

Notebook checks include security labels and credential grants.
Final checks compare metadata, source, code, and output ETags with the indexed fingerprint.
Changed content is excluded until a later crawl publishes a matching document. Live checks exclude deleted resources.

Integration checks require `integration.use`, an enabled and unshadowed integration, and matching version/update time.
Live namespace and schema probes use the caller's upstream identity before ranking and returning results.
Indexed fields contain names, kinds, and column types. Configuration, credentials, and rows are excluded.
Chat-owner filtering runs before source checks, but no chat source is registered.

Keyword retrieval unions whole-token postings. Ranking weights title matches above body matches.
Hybrid queries fuse lexical and cosine ranks using reciprocal rank fusion.
Scores reflect local ranks, not calibrated relevance across projects or sources.
A weak local first-place match can tie a strong match elsewhere. Scores are unstable API details: preserve response order and avoid numeric thresholds.
`rank.test.ts` fixes expected ordering for a small mixed-kind, multilingual corpus, exact tokens, ties, and vector compatibility.
Expand this relevance set before changing weights or introducing global reranking.

Candidate limits apply before resource authorization and scoring, so unauthorized candidates can reduce recall.
Final checks can also reduce the result count; results are not refilled from lower-ranked candidates.
Checks are not transactional across project, resource, and upstream state. A later revocation cannot retract a delivered response.

## Publication and recovery

Each project/source head points to an immutable snapshot or retained deletion tombstone under `_system/search/projects/`.
These records sit outside project cleanup prefixes. The [bucket specification](./bucket_spec.md#search-indexes) defines their owners.

Before crawling, the indexer claims a build identity on the head through CAS, preserving the previous snapshot.
The identity contains a deployment revision, source revision, and configuration string (source options and notebook embedding identity).
Neither numeric revision may decrease. Different configurations at equal revisions fail with a request to increase `MARIMOHUB_SEARCH_BUILD_REVISION`.
This prevents mixed configurations from repeatedly replacing each other during a rollout.

The indexer stages immutable pages behind a CAS checkpoint containing the build identity and original head revision.
A ready marker permits publication retries without repeating the final page.
Serialized checkpoints cannot exceed 128 KiB, including UTF-8 cursor bytes, JSON escaping, and page references.
If the next checkpoint exceeds this limit, the indexer drops the cursor and publishes the collected pages with partial coverage.
Oversized stored checkpoints restart without parsing their bodies; replacement still requires the stored ETag.
Cleanup skips these checkpoints until the scheduled crawl replaces them.
Publication writes the snapshot, then replaces the head only if that revision still matches.
Readers retain the previous snapshot throughout the crawl. A changed head or build identity resets the checkpoint before reading its source cursor.
Unversioned checkpoints also restart. Superseded workers skip discovery; workers already in flight lose publication CAS.
A failed replacement leaves the previous snapshot available. Rollbacks must preserve monotonic revisions and compatible source formats.

Project existence is checked before discovery and publication.
Deleted projects receive tombstone heads even without an earlier snapshot, fencing delayed first publications.
After tombstoning, the indexer CAS-replaces the crawl with an empty checkpoint. A conflicting checkpoint write retries retirement on the next pass.
Both records remain: a delayed writer cannot recreate a first checkpoint or publish against the current tombstone.
Live checks filter deleted resources until the next snapshot excludes them.

Cleanup fences CAS records before deleting obsolete objects.
It preserves current snapshots, active crawl pages, objects younger than 24 hours, and deletion heads.
Each cleanup pass examines at most 100 snapshots and 100 pages per source.
Detached objects become eligible after the grace period; storage failures or maintenance downtime delay reclamation.

Maintenance uses a lease and visits project/source pairs in round-robin order.
Attempts run every five seconds, process at most four pages, and have a 30-second deadline.
Final assembly reads at most eight pages concurrently, preserves page order, and stops scheduling after a failure.
The ready checkpoint preserves discovery progress, but assembly restarts on each retry.
Persistent deadline exhaustion can prevent publication. [Resumable assembly is deferred](#deferred-resumable-assembly).

## Assumptions

| Requirement                                                      | Dependency                                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Correct ETag CAS and create-if-absent writes                     | Publication, checkpoints, and deletion fences                                         |
| ETags change with content; validated reads observe current state | Freshness and permission checks                                                       |
| Stable resource IDs without reuse                                | Persisted references and deletion fences                                              |
| Discovery identity can enumerate the intended catalog            | Caller checks can restrict results but cannot recover content absent from the index   |
| Monotonic build/source revisions                                 | Rolling deployments cannot reclaim incompatible newer builds                          |
| Stable embedding endpoint/model identity                         | Changing model behavior requires a new identity to avoid reusing incompatible vectors |
| Index storage receives the original content's access controls    | Snapshots copy potentially sensitive code and output text                             |

Cancellation stops scheduling work and rejects timed operations.
Individual bucket calls have no abort interface and can continue after cancellation.
Embedding and catalog calls receive cancellation signals where supported.

## Resource budgets

| Resource                | Bound                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------ |
| Project/source snapshot | 16 MiB and 20,000 documents                                                          |
| Notebook artifacts      | 2 MiB per code or output artifact                                                    |
| Indexed text            | 8,192 characters per hit type per resource                                           |
| Cross-project discovery | First 16 non-deleted catalog projects, selected before authorization                 |
| Query concurrency       | Two projects or final-validation batches; eight notebook checks per batch            |
| Query deadline          | Three seconds: half for retrieval, half for final validation                         |
| Candidates              | 200 per project/source, before authorization and ranking                             |
| Results                 | At most 50, with snippets of at most 400 characters                                  |
| Catalog validation      | At most 32 probes per source validation phase                                        |
| Catalog crawl           | 500 queued tasks, 500 visited namespaces, 25 entries per page, 100 columns per table |
| Crawl assembly          | Eight concurrent page reads; retries restart assembly                                |
| Crawl checkpoint        | 1,000 pages, 65,536 cursor characters, and 128 KiB of serialized checkpoint state    |
| Index cache             | 64 MiB of estimated cache weight per process                                         |
| Stale status            | Index timestamp older than 15 minutes                                                |

## Tradeoffs and scalability

| Design                                   | Benefit                                                                                   | Limit                                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Immutable project/source snapshots       | Simple atomic publication and recovery                                                    | Cold reads load the whole snapshot; completed crawls rewrite it                       |
| In-memory token postings                 | Warm queries avoid body scans                                                             | Each process rebuilds postings on cache misses                                        |
| Live authorization and freshness checks  | Revocation and deletion do not depend on crawl lag                                        | Storage HEAD calls and catalog probes remain on the query path                        |
| Bounded candidates and partial responses | Predictable request work; source failures remain isolated                                 | Broad queries can miss better or authorized matches                                   |
| Optional embeddings with reuse           | Keyword search survives provider failures; unchanged text avoids repeated embedding calls | Crawling and snapshot writes remain; semantic retrieval has no nearest-neighbor index |

**Project scope.** Explicit project queries bypass global discovery, but still read the current index head.
Cold retrieval loads the complete snapshot and builds all postings.
One notebook can produce three documents. Content or vectors can exhaust the byte budget before the document limit.

**Memory and concurrency.** The 64 MiB cache budget estimates weight as four times serialized size; it is not a heap cap.
Temporary allocations and concurrent cold loads add memory. Duplicate cold reads are not coalesced.
Per-request limits do not provide global admission control or establish concurrent-user capacity.

**Cross-project scope.** Discovery selects the first 16 non-deleted catalog projects before authorization.
Accessible projects later in catalog order can be omitted. Explicit project selection avoids this cap.
Two projects run concurrently, with sources sequential within each project.
Global catalog reads, full crawls, and cache churn remain scaling costs.

**Catalog scope.** Discovery and each live-check phase list merged project and organization integrations, up to 500 heads per scope.
These reads can dominate before the 32-probe validation budget is reached.
Schema probes are memoized within a request, never shared across principals.
Pagination, provider permissions, and crawl limits can leave catalog content unindexed.

### When to change the design

| Constraint                             | Candidate improvement                                                 | Preserve                                                  |
| -------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------- |
| Large snapshots or cache churn         | Persist partitioned postings                                          | Atomic manifests and deletion fences                      |
| Full crawls dominate traffic           | Dirty-resource scheduling, reusable segments, periodic reconciliation | Resumability and deletion discovery                       |
| Concurrent cold loads                  | Coalesce reads and add admission limits                               | Independent cancellation and live authorization           |
| Broad queries lose authorized matches  | Bounded candidate pagination                                          | Authorization before scoring and total work limits        |
| Cross-project coverage is insufficient | Paginated discovery or an authorized project directory                | Current membership checks and explicit coverage           |
| Catalog checks dominate latency        | Targeted integration lookups and batch schema checks                  | Caller identity and current permissions                   |
| Semantic recall needs larger corpora   | Vector-capable backend                                                | Content opt-in, compatible vectors, and final live checks |

The audit log is not a durable change feed: appends are best-effort after catalog commits.
Future indexing notifications must remain hints with periodic reconciliation, unless a durable outbox or equivalent delivery mechanism is added.

These are follow-ups, not implemented capabilities. Raising limits alone increases memory, traffic, and deadline pressure.
A richer full-text library must still separate candidate retrieval from authorized scoring.

### Deferred: resumable assembly

**Status: deferred.** Bounded concurrency protects storage and permits safe retries, but does not guarantee publication at arbitrary storage latency.
For example, 400 page reads at one second each require at least 50 seconds with eight concurrent reads.
Even when each read succeeds, every 30-second attempt can fail on that corpus.
Discovery, parsing, and publication consume additional time.

Retries repeat completed page reads. The previous snapshot remains available subject to live authorization and freshness checks.
Without a previous snapshot, search continues to report `not_indexed`. An existing snapshot reports `stale` after 15 minutes.
Retrying alone does not resolve persistent deadline exhaustion.

The follow-up is resumable compaction or an atomic manifest over immutable segments.
This requires durable intermediate state, cleanup rules, and publication fencing beyond the current crawl checkpoint.
Acceptance criteria:

- Persist bounded assembly progress across attempts and process restarts without repeating all completed page reads.
- Preserve build identity, ETag CAS publication, deletion tombstones, and the previous snapshot until the replacement is complete.
- Bound reads, concurrency, bytes, and memory per attempt. Reclaim abandoned segments without deleting active work.
- When individual operations fit the budget, demonstrate eventual publication across attempts whose total assembly time exceeds the deadline.
- Cover cancellation, crashes, concurrent writers, build changes, deletion during compaction, and failed final publication.

When an individual storage operation consistently exceeds its deadline, even resumable assembly cannot guarantee progress.
Higher concurrency or longer deadlines alone do not satisfy these criteria.

## Validation and performance

Regression tests cover authorization races, private-owner filtering, freshness, cancellation, crawl recovery, CAS conflicts, tombstones, and corrupt storage.
Provider tests cover malformed vectors, oversized streams, repeated cursors, catalog limits, and upstream revocation.
REST/MCP tests cover matching results, request rejection, and partial failures without provider error details.

Latency-injected lifecycle tests model 400 and 1,000 page GETs at 100 ms each, with 20 documents per page and eight concurrent reads.
Their simulated assembly times are 5 and 12.5 seconds, within the 30-second attempt budget; the serial equivalents exceed it.
These tests establish bounded scheduling and safe failure, not progress under persistent slow storage or remote-storage capacity.
Deployment benchmarks still need remote storage, real catalogs, concurrent callers, uneven project sizes, and cache churn.
Measure tail latency, storage/catalog calls, bytes, peak heap, crawl lag, coverage, and authorized recall before setting production targets.

### Local benchmark

Run the opt-in benchmark:

```sh
SEARCH_BENCH=1 pnpm --filter @marimo-hub/config test src/search.performance.test.ts
```

The benchmark seeds filesystem objects and runs the configured indexer and authorized query service. It writes `.context/search-performance.json`. Cold queries use fresh application caches. The OS cache may remain warm. Warm p95 is the largest of ten subsequent samples.

Measured on macOS with Node 24.22.1 and local filesystem storage, November 2, 2026:

| Notebooks | Query     | Cold    | Warm median | Warm p95 | Cold GET / HEAD | Warm GET / HEAD | Coverage               |
| --------- | --------- | ------- | ----------- | -------- | --------------- | --------------- | ---------------------- |
| 1,000     | Selective | 28.3 ms | 5.0 ms      | 8.9 ms   | 33 / 43         | 21 / 54         | Complete indexed scope |
| 1,000     | Broad     | 27.9 ms | 11.4 ms     | 13.6 ms  | 116 / 43        | 21 / 137        | Candidate cap          |
| 5,000     | Selective | 90.3 ms | 7.7 ms      | 13.8 ms  | 73 / 43         | 21 / 94         | Complete indexed scope |
| 5,000     | Broad     | 73.7 ms | 9.7 ms      | 15.3 ms  | 109 / 39        | 19 / 128        | Candidate cap          |

Each notebook contains metadata and approximately 1.2 KiB of Python code. One quarter also has approximately 300 characters of saved output. The corpora contain 2,250 and 11,250 searchable documents. Selective queries match one of 100 cohorts; broad queries match common revenue terms. Each query requests 20 results.

All measured queries made zero bucket LISTs and zero data-catalog probes. Cold GET payloads were approximately 2 MiB and 10 MiB. Warm GET payloads were approximately 4.5 KiB. HEAD calls still validate live authorization and artifact freshness. Index generation took approximately 1.1 and 8.1 seconds, excluding corpus creation and maintenance scheduling delays.

The corpus meets the local targets: cold latency below 500 ms and warm p95 below 150 ms.
Broad-query measurements cover truncated results. These measurements exclude remote storage, catalog providers, concurrent load, and semantic quality.

## Web client

One `SearchPage` serves global and project routes from `lib/workspaceSearch.ts`.
The path sets scope. `q`, `kind`, and `mode` set filters.
Typing replaces history. Scope and filter changes create entries.
`useSearchAccess` shares capability and account checks across navigation, shortcuts, and the page.
`SearchFilters` uses the shared React Aria `Select`. Semantic search uses `CheckboxField` and `CheckboxButton`.
The [user guide](../docs/search.md#search-in-the-web-app) describes the controls.

Query keys include the caller and request fields. Disabling search or changing inputs cancels the previous request.
Each input edit resets a 500 ms timer, including edits that return to the previous query. Enter or the Search button cancels the timer and submits immediately. Bookmarked queries load immediately. Active IME composition suspends requests and submission.
Pending, paused, and failed requests hide old results.
Unused query entries expire immediately, so revisits require authorization again.
Requests, window focus, and reconnect check permissions; there is no push revocation feed.

Snippets use text and UTF-16 highlight offsets, never HTML.
Shared test fixtures cover account changes, offline recovery, cancellation, late responses, invalid filters, capability failures, keyboard boundaries, and Unicode.
