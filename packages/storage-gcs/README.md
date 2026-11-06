# @marimo-hub/storage-gcs

`Bucket` storage adapter for Google Cloud Storage.

Part of [marimohub](../../README.md). See [docs/storage.md](../../docs/storage.md) for configuration.

## Conditional reads

The adapter uses GCS generations as ETags and sends `ifGenerationNotMatch` for
[conditional reads](../../development_docs/bucket_spec.md#conditional-reads).

If a body response has no `x-goog-generation`, the read fails. CAS writes require
a generation tied to those bytes. A later metadata lookup can return a newer
generation and cannot safely supply the missing token.
