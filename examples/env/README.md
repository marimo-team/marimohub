# Example environment files

Copy-pasteable starting points for common deployments. They cover only the vars
that matter for each scenario — the full surface is in
[`docs/configuration.md`](../../docs/configuration.md) and
[`apps/server/.env.example`](../../apps/server/.env.example).

| File                                                     | Use case                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| [`dev-local.env`](./dev-local.env)                       | Local dev. In-memory state, dev auth bypass. Not for real users.   |
| [`production-s3-oidc.env`](./production-s3-oidc.env)     | S3 storage + Modal compute + OIDC login.                           |
| [`production-coreweave.env`](./production-coreweave.env) | CoreWeave CAIOS + Sandboxes + OIDC + Workload Identity Federation. |

Values marked `# secret` belong in a secrets manager, not in committed files.

After deploying, confirm downstream dependencies with the deep health check:

```bash
curl -s -b "$COOKIE" 'https://<your-host>/api/health?deep=true' | jq
```

See [Troubleshooting](../../docs/troubleshooting.md) for what the report and any
startup refusal mean.
