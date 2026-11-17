# Persistence failure validation (MO-8654)

Local tests use a fake sandbox and `MemoryBucket`. They measure generation loss, not elapsed loss or real-cluster behavior.
The artifact matrix publishes `saved`, writes `latest`, injects a failure, and reconstructs `NotebookService` to check stored bytes.

Base commit `a3d29d178` plus this change passed 665 tests across six persistence suites and 71 server bootstrap tests.

## Reproducible local matrix

Run from the repository root:

```sh
pnpm --filter @marimo-hub/core exec vp test run src/services/runtime/sessionCapture.test.ts src/services/runtime/sessionStop.test.ts src/services/runtime/sessionLifecycle.test.ts src/services/runtime/SandboxProvisioner.test.ts src/services/runtime/sandboxFiles.test.ts src/services/runtime/SessionRetirer.test.ts
pnpm --filter @marimo-hub/server exec vp test run src/bootstrap.test.ts
```

| Failure model                              | Recovered contents                                                                     | Loss window represented                                                 | Coverage                                                                          |
| ------------------------------------------ | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Successful final capture                   | `latest` source, dependencies, HTML, session JSON, and workspace data                  | No lost test generation                                                 | `sessionCapture.test.ts`: `final-capture`; stop protocol in `sessionStop.test.ts` |
| Sandbox unavailable after periodic capture | `saved` source, dependencies, HTML, and session JSON; no new workspace data            | All changes since the last capture                                      | `sessionCapture.test.ts`: `sandbox-loss`                                          |
| Bucket rejects publication head            | Previous `saved` artifacts remain readable; unpublished payloads do not become current | All changes since the last successful publication                       | `sessionCapture.test.ts`: `storage-failure`                                       |
| Hub service reconstructed                  | Published `saved` artifacts remain readable                                            | Uncaptured generation is absent from bucket; live sandbox may retain it | `sessionCapture.test.ts`: `hub-restart`                                           |
| Lost publication acknowledgement           | Published source can exist despite an uncertain result                                 | Unknown until reconciliation                                            | Lost-acknowledgement test in `sessionCapture.test.ts`                             |
| Capture failure during stop                | Runtime retained for retry                                                             | No destruction by normal stop                                           | `sessionStop.test.ts`, `SessionRetirer.test.ts`                                   |
| Maintenance delay or failure               | Snapshot timestamp stays old until success                                             | Gap can exceed configured interval                                      | `sessionLifecycle.test.ts`                                                        |

Provisioning and workspace suites cover restore paths, exclusions, limits, and no-write-back behavior.
Coordinator tests cover retries, receipt failure, runtime loss during resume, workspace-only failure, clock skew, and safe diagnostics.

## Cluster matrix: pending execution

Real Pod deletion, node loss, and hub process restart have not been executed for this issue.
Use an isolated deployment and disposable notebooks. Record the commit, provider, runtime image, storage backend, cadence, and maintenance configuration.

1. Start a persistent local editor with a nested imported entrypoint.
2. Write a numbered source generation and matching dependency, HTML, session JSON, and data files.
3. Record each write time and hash outside the sandbox.
4. Wait for a durable receipt, then write another numbered generation.
5. Apply one failure from the table below.
6. Start a replacement session and record recovered paths, hashes, and generation numbers.
7. Record the failure time, last receipt time, and last recovered generation time.
8. Repeat with source mode, workspace mode, and a storage outage spanning several capture intervals.
9. Repeat no-write-back checks with app, ephemeral, and remote-source sessions.

| Scenario        | Injection                                                           | Required observation                                                                           |
| --------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Graceful stop   | Normal session stop API                                             | Critical capture before destruction; optional workspace outcome                                |
| Pod deletion    | Delete only the selected sandbox Pod with normal grace              | Whether provider termination permits capture; recovered artifacts                              |
| Abrupt Pod loss | Force-delete the selected sandbox Pod without grace                 | Last published generation and generated-data loss                                              |
| Node loss       | Terminate the isolated sandbox node through the test infrastructure | Recovery without a runtime teardown callback                                                   |
| Hub restart     | Restart only the hub between writes and the next capture            | Sandbox survival, resumed maintenance, receipt continuity                                      |
| Storage failure | Deny test-bucket writes, then stop or wait for periodic capture     | Retained normal stop, incomplete events, unchanged receipt; successful retry after restoration |

For each run, store this record beside deployment logs:

```text
commit, provider, runtime_image, scenario, persistence_mode, interval_seconds
write_times_and_hashes, failure_at, last_durable_capture_at
recovered_source, recovered_dependencies, recovered_html, recovered_session, recovered_data
capture_age_at_failure_ms, newest_recovered_generation_age_ms
stop_outcome, capture_failure_code, maintenance_delay_ms
```

Use generation timestamps to measure recovered content age; receipt timestamps measure acknowledgement age.
Record missing artifacts as absent, not as zero-second loss. Cluster loss bounds remain unmeasured until these records exist.
