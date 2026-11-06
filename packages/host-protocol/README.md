# @marimo-hub/host-protocol

A platform-neutral server for the [marimo host protocol](https://github.com/marimo-team/marimo/tree/main/protocols/host).
It owns routing, RFC 9457 problem responses, server-sent event streams, catalog diffing,
Idempotency-Key semantics, and the rewriting of runtime IDs into platform notebook IDs.

A platform becomes a host by implementing `HostPlatform`: authentication, the catalog of
projects and notebooks with their permitted operations, notebook creation and renaming,
runtime lifecycle, and the transport to a running runtime. `createHostApp(platform)` returns
a Hono app to mount at any prefix.

`./bridge` exports the loopback Python client that reaches a marimo host inside a sandbox
from a sandbox `exec`, the event and reply schemas it speaks, and the request type it reads.
`./retry-store` exports the Idempotency-Key store contract and its timing constants, so a
durable store can be implemented without importing the HTTP server.

Depends on `hono` and `zod` only. Part of [marimohub](../../README.md).
