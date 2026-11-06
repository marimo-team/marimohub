# @marimo-hub/storage-r2

`Bucket` storage adapter for Cloudflare R2.

Part of [marimohub](../../README.md). See [docs/storage.md](../../docs/storage.md) for configuration.

## Conditional reads

The adapter sets `onlyIf.etagDoesNotMatch` and maps bodyless responses to the
[conditional-read result](../../development_docs/bucket_spec.md#conditional-reads).
