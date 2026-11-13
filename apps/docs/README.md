# @marimo-hub/docs

The documentation site (VitePress). Content lives in [`docs/`](../../docs); this app builds and serves it.

Part of [marimohub](../../README.md).

## Deployment

[Deploy docs](../../.github/workflows/deploy-docs.yml) builds the site in GitHub Actions and uploads the build output to Vercel.
Changes to docs or build inputs on `main` deploy to <https://marimohub.docs.marimo.io>.
Pull requests from this repository deploy previews. Fork pull requests do not receive deployment credentials.
Manual runs deploy production from `main` and previews from other branches.
The workflow summary contains the deployment URL.

The workflow fetches `VERCEL_TOKEN` from the `docs` config in the Doppler project `marimohub-oss`.
The GitHub secret `DOPPLER_TOKEN_DOCS` grants read-only access to that config.
The GitHub repository variables `VERCEL_PROJECT_ID` and `VERCEL_ORG_ID` select the Vercel project and team.
Build commands and Git deployment settings are defined in `vercel.json`.
