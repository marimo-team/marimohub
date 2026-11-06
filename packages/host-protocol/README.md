# @marimo-hub/host-protocol

A platform-neutral server for the [marimo host protocol](https://github.com/marimo-team/marimo/tree/main/protocols/host).
It owns routing, RFC 9457 problem responses, server-sent event streams, catalog diffing,
Idempotency-Key semantics, and the rewrite of runtime IDs into platform notebook IDs.

A platform becomes a host when it implements `HostPlatform`. The port covers authentication, the
catalog of projects and notebooks with their permitted operations, notebook creation and
renaming, runtime lifecycle, and transport to a running runtime. `createHostApp(platform)`
returns a Hono app to mount at any prefix.

| Subpath         | Exports                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| `./bridge`      | The host relay, the event and reply schemas it uses, and the request type it reads.                                |
| `./retry-store` | The Idempotency-Key store contract and its timing constants. A durable store can use them without the HTTP server. |
| `./testing`     | Test-only: the `HostRetryStore` conformance suite and `hostRetriesFor`. Imports `vitest`; load it only from tests. |

The host relay is the loopback Python client that reaches a marimo host inside a sandbox through
a sandbox `exec`. It is unrelated to the notebook bridge (`@marimo-hub/notebook-bridge`).

Depends on `hono` and `zod` only at runtime. For the hub's endpoint, see
[Host protocol](../../docs/host-protocol.md). Part of [marimohub](../../README.md).
