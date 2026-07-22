<!-- Setup snippet — included by docs/storage.md and rendered in the deployment wizard. -->

Store everything in a directory on the host — no external store to run:

```bash
MARIMOHUB_STORAGE_BACKEND=fs
MARIMOHUB_STORAGE_FS_ROOT=/var/lib/marimohub/storage
```

The directory is created if missing, and objects appear in it as plain files
(`_system/…`, `projects/…`) you can browse and back up directly. Keep the root
on a single filesystem/volume — writes rely on atomic renames, which don't work
across mount points.

::: warning Single replica only
Conditional writes (the compare-and-swap that protects concurrent notebook
edits) are enforced within one server process. Never run two hub replicas
against the same directory — concurrent edits could lose catalog updates. The
server logs a preflight warning at startup to remind you. Use `s3` or `gcs` for
multi-replica deployments.
:::

Pairs naturally with the `local` or `docker` compute backends on the same
machine. Sandboxes can't reach the directory as an S3 bucket, so notebook file
sync uses the hub-mediated fallback copy — which those backends already do.
