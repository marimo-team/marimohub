# Endpoint storage cost snapshots

Run `pnpm test:perf` from the repository root. These tests also run with the
normal API suite and `pnpm test`; they do not require credentials or a server.

The default/legacy reports are [small](./endpoint-costs.small.md) (50 notebooks) and
[large](./endpoint-costs.large.md) (10,000 notebooks). Both include 2,000 reclaimed
session records and five live sessions. Memberships vary between editor, viewer,
app-user, and no access. Each scenario starts from its own copy of the data.

The steady-state reports are [small](./endpoint-costs.steady.small.md) and
[large](./endpoint-costs.steady.large.md). They run the registered background migrations to completion and provide
core services with a background-work queue. Setup runs outside measurement.
Run only these profiles with `pnpm test:perf -t steady`.
These profiles also cover reopening a claimed editor on a fresh replica and
unchanged periodic saves. Use them to judge routine user-facing costs.

The default profile retains scan-based admission, missing persistent indexes,
and legacy project summaries before background migration.
Its first session admission includes missing-index recovery. Keep this profile for comparison;
do not replace it with the steady-state profile to hide migration costs.
Service options are explicit: environment variables do not configure these tests.
Project-list assertions check exact visible IDs, and `/me` checks app-only status,
so skipping authorized projects cannot appear as a performance improvement.

Each report records:

- **Storage calls:** calls to the bucket port, including conditional GETs that
  return 304, missing objects, and each LIST page. A batch delete is one port
  call; an adapter may split it into several network requests.
- **Rounds:** sequential I/O rounds, including the first. Concurrent calls cost
  one round. A concurrency limit of 16 makes 50 independent reads take four rounds.
- **Estimated milliseconds:** rounds × 25 ms. Multiply rounds by another assumed
  per-call latency to compare storage environments.
- **Calls/round:** parallel widths in execution order. `16×3` means three rounds
  with 16 calls each. Changes here expose lost parallelism even if totals stay flat.
- **Operations:** GET, conditional GET/304, HEAD, LIST, PUT, and DELETE counts.

Cold means fresh API services and caches over an existing deployment with identity
records. Warm is the next call on the same services. Session creation and reuse are
named separately from the scenario that starts a new editor on each call. Session
lookup, heartbeat, and periodic save create their editor before measuring, then use
fresh services for the cold call. Deferred tasks run after the response and have
their own rows; their time is not part of response latency.

## How the model works

The real API and core services run against `MemoryBucket`, fake compute, and a
memory search index. `RoundTripBucket` holds pending calls until the next event-loop
turn, then releases them together. Promise continuations run before the next batch.
This models equal-duration requests without wall-clock timing or 25 ms sleeps.
Unit tests cover serial chains, parallel branches, joins, bounded fan-out, and 304s.

Fixture IDs and dates are stable. Search indexing runs against each scenario’s copy
so fingerprints match its ETags. Setup and indexing are outside the measured region.
Hashing uses Node’s synchronous implementation in the test, with the same output,
so worker-thread completion order does not add scheduling noise. The clock stays
fixed so cache TTLs and session expiry do not depend on CI speed. The model assumes other work completes through synchronous code or promise
microtasks; real timers and external I/O must not be added to these fixtures.

This is a storage dependency model, not an end-to-end latency benchmark. It excludes
CPU, payload transfer, browser HTTP waterfalls, authentication-provider requests,
compute-provider calls, sandbox boot, contention, retries, and cache expiry. The
estimated milliseconds are the storage contribution under the stated assumptions.

## Reviewing changes

Changes to counts, rounds, operation mix, or parallel widths fail the snapshot test,
including improvements. To accept an intentional change:

```sh
pnpm test:perf:update
git diff -- packages/api/src/testing/performance/endpoint-costs.*.md
pnpm test:perf
```

Review and commit the report changes with the implementation. Explain increases
and check both scales for new fan-out. Avoid updating snapshots automatically in CI.
Add endpoint scenarios to `ENDPOINTS` in `endpointCosts.test.ts`; assert successful
responses so an error path cannot silently become a cheaper baseline.
