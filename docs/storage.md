# Storage

Storage is where MarimoHub keeps everything — notebooks, their version history,
and session state. There is no separate database, so the object store is the only
thing you need to back up.

Selector: `MARIMOHUB_STORAGE_BACKEND`. Full variables: [Configuration → Storage](./configuration.md#storage).

## Backends

| Backend | Selector | Durable | Use for                                                   |
| ------- | -------- | ------- | --------------------------------------------------------- |
| S3      | `s3`     | ✅ yes  | Production (CoreWeave CAIOS, AWS S3, MinIO, Tigris, Ceph) |
| GCS     | `gcs`    | ✅ yes  | Production on Google Cloud (native GCS JSON API)          |
| R2      | `r2`     | ✅ yes  | Cloudflare Workers (native binding)                       |
| Memory  | `memory` | ❌ no   | Dev/tests only (volatile)                                 |

`s3` is the default and, with `gcs`, one of the two durable backends for the Node
server. `r2` is Workers-only (supplied as a binding, not credentials). `memory`
requires `MARIMOHUB_ALLOW_EPHEMERAL_STORAGE=true` so it can never back a real
deployment by accident.

## Requirement: atomic conditional writes

MarimoHub relies on atomic conditional writes to update notebooks safely under
concurrent edits. Your store **must** support them — MarimoHub checks this at
startup and refuses to run on a store that doesn't. CoreWeave CAIOS, AWS S3, R2,
MinIO (recent), and Tigris all qualify via S3 `If-Match`; Google Cloud Storage
qualifies via object **generations** (`ifGenerationMatch`).

## S3-compatible setup

<!--@include: ./setup/storage/s3.md-->

## Google Cloud Storage

<!--@include: ./setup/storage/gcs.md-->

## Memory (dev/tests)

<!--@include: ./setup/storage/memory.md-->
