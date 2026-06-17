# Security policy

## Supported versions

marimohub is pre-1.0. Security fixes target the main branch unless maintainers
publish a release support policy.

## Report a vulnerability

Do not open a public issue with vulnerability details.

Use GitHub private vulnerability reporting for this repository if it is enabled.
If it is not enabled, open a minimal public issue asking maintainers for a
private reporting path and do not include technical details, proof-of-concept
steps, credentials, hostnames, logs, or screenshots.

## What to include privately

- Affected version or commit.
- A short description of the issue and impact.
- Minimal reproduction details.
- Whether the issue affects storage, compute, auth, API, web UI, deployment
  configuration, or documentation.
- Any known mitigations.

Never include real secrets. If a committed or logged secret is involved, identify
the credential type and location, then rotate it.

## Security-relevant docs

- [Security model](./docs/security.md)
- [Operations](./docs/operations.md)
- [Project secrets](./docs/secrets.md)
- [Configuration](./docs/configuration.md)
