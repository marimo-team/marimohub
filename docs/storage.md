---
description: Select built-in or external storage for marimohub.
---

# Storage

Storage is where marimohub keeps notebooks, version history, session records, and
system metadata. There is no separate database, so the storage backend is the
state you back up and recover.

Selector: `MARIMOHUB_STORAGE_BACKEND`. Full variables:
[Configuration -> Storage](./configuration.md#storage).

## Choose a backend

| Backend    | Selector  | Durable | Use for                                       |
| ---------- | --------- | ------- | --------------------------------------------- |
| S3         | `s3`      | Yes     | CoreWeave CAIOS, AWS S3, MinIO, Tigris, Ceph  |
| GCS        | `gcs`     | Yes     | Google Cloud Storage                          |
| Azure      | `azure`   | Yes     | Azure Blob Storage                            |
| Filesystem | `fs`      | Yes     | Single-node self-hosting on a local disk      |
| R2         | `r2`      | Yes     | Cloudflare Workers through a platform binding |
| Memory     | `memory`  | No      | Local development and tests only              |
| External   | `library` | Varies  | Operator-provided Node adapter                |

`s3` is the default for the Node server. `fs` needs no external store but is
single-replica only (see below). `r2` is Workers-only because it uses a runtime
binding instead of credentials. `memory` requires
`MARIMOHUB_ALLOW_EPHEMERAL_STORAGE=true` so it cannot back a real deployment by
accident.

## Requirement: atomic conditional writes

marimohub relies on atomic conditional writes to update notebooks safely under
concurrent edits. Your store must support them. The server checks this at
startup and refuses to run on a store that ignores conditional writes.

Known-good options:

- CoreWeave CAIOS, AWS S3, R2, recent MinIO, and Tigris through S3 `If-Match`.
- Google Cloud Storage through object generations (`ifGenerationMatch`).
- The `fs` backend enforces conditional writes within a single server process
  (and the server logs a startup warning saying so). That is safe for one
  replica; run multiple replicas only on `s3`, `gcs`, or `azure`.

## Configure it

### S3-compatible setup

<!--@include: ./setup/storage/s3.md-->

### Google Cloud Storage

<!--@include: ./setup/storage/gcs.md-->

### Azure Blob Storage

<!--@include: ./setup/storage/azure.md-->

### Filesystem setup

<!--@include: ./setup/storage/fs.md-->

### Memory (dev/tests)

<!--@include: ./setup/storage/memory.md-->

### External library

<!--@include: ./setup/storage/library.md-->

## Validate it

After deploy:

1. Start the server and check that startup does not report a fatal storage
   preflight failure.
2. Create a project.
3. Create and save a notebook.
4. Restart the server.
5. Confirm the project and notebook are still present.

## Production cautions

- Back up the object store. It is the database.
- Do not use `memory` outside local development or tests.
- With `fs`, run exactly one hub replica and back up the storage root directory;
  keep it on a single filesystem/volume.
- Keep bucket permissions narrow. The hub needs access only to its own prefix or
  bucket.
- Treat conditional-write failures as a storage compatibility issue, not as a
  transient app bug.

## Troubleshooting

See [Troubleshooting -> The server refuses to start](./troubleshooting.md#the-server-refuses-to-start)
and [Operations -> Backups & restore](./operations.md#backups-restore).
