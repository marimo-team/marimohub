# @marimo-hub/storage-gcs

`Bucket` storage adapter for Google Cloud Storage.

Part of [marimohub](../../README.md). See [docs/storage.md](../../docs/storage.md) for configuration.

## Conditional reads

The adapter uses GCS generations as ETags and sends `ifGenerationNotMatch` for
[conditional reads](../../development_docs/bucket_spec.md#conditional-reads).

If the body response omits `x-goog-generation`, its ETag is empty and disables
caching. A later metadata lookup cannot identify the generation of earlier bytes.
