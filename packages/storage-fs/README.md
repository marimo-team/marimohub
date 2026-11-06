# @marimo-hub/storage-fs

`Bucket` storage adapter backed by a directory on the local filesystem.

Part of [marimohub](../../README.md). See [docs/storage.md](../../docs/storage.md) for configuration.

## Conditional reads

For [conditional reads](../../development_docs/bucket_spec.md#conditional-reads),
ETags combine device, inode, size, and nanosecond modification time from the open
file descriptor. `head` and unchanged conditional reads do not read the body.
ETags survive atomic publication and process restarts. Identical rewrites can
change the ETag.
