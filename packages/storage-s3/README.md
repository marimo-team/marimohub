# @marimo-hub/storage-s3

`Bucket` storage adapter for Amazon S3 and S3-compatible stores.

Part of [marimohub](../../README.md). See [docs/storage.md](../../docs/storage.md) for configuration.

## Conditional reads

The adapter sends a quoted `If-None-Match` header and maps HTTP 304 to the
[conditional-read result](../../development_docs/bucket_spec.md#conditional-reads).
