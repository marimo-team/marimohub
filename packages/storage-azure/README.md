# @marimo-hub/storage-azure

`Bucket` storage adapter for Azure Blob Storage.

Part of [marimohub](../../README.md). See [docs/storage.md](../../docs/storage.md) for configuration.

## Conditional reads

The adapter passes a quoted ETag to the download condition and maps HTTP 304 to
the [conditional-read result](../../development_docs/bucket_spec.md#conditional-reads).
