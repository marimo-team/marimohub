# @marimo-hub/storage-gcs

`Bucket` storage adapter for Google Cloud Storage.

Part of [marimohub](../../README.md). See [docs/storage.md](../../docs/storage.md) for configuration.

## Conditional reads

The adapter uses GCS generations as ETags and sends `ifGenerationNotMatch` for
[conditional reads](../../development_docs/bucket_spec.md#conditional-reads).

A body response without `x-goog-generation` fails the read.
CAS writes need the generation of those exact bytes.
A later metadata lookup can return a newer generation, so it cannot supply the missing value.
An emulator must return `x-goog-generation` on media downloads.
