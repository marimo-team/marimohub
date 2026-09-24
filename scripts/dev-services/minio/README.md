# MinIO images

CI and local development pull `ghcr.io/marimo-team/marimohub-minio` by digest.
Both variants include the MinIO server and `mc`, with AMD64 and ARM64 builds:

- `ci`: the September 2025 release used by storage and object-browser tests.
- `dev`: the April 2025 release that retains the local web console.

The `Publish MinIO images` workflow builds and checks both variants when its
Dockerfile or workflow changes. Pull requests only build and test. Pushes to
main publish images tagged with the source commit and variant.

To publish before updating consumers, push a tag at the desired source commit:

```sh
git tag minio-images/<unique-label>
git push origin minio-images/<unique-label>
```

The workflow also supports manual dispatch. Its summary reports the complete
image references with manifest digests. Update the `ci` digest in
`.github/workflows/{storage,object-browser}-conformance.yml` and the `dev`
digest in `scripts/dev-services/compose.yaml`. Keep the package public so forks
and local Docker installations can pull without credentials.
