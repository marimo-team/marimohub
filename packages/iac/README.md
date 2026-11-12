# @marimo-hub/iac

Manage project integrations with typed declarations, previews, and repeatable upserts.
Runs in Node 24.11+ and Deno 2.5+. No runtime dependencies or install scripts.

```ts
import { createHub, integration, secret } from '@marimo-hub/iac';

const target = createHub({ url, token }).project(projectId).integrations;
await target.upsert(
	integration('postgres', 'warehouse', {
		host: 'db.internal',
		database: 'analytics',
		username: 'reader',
		password: secret.ref('aws-sm', 'prod/warehouse#password'),
	}),
);
```

Use an existing project and a scoped PAT or enabled OIDC token with `integration.read` and `integration.manage`.
See [the integration IaC guide](https://github.com/marimo-team/marimohub/blob/main/docs/integration-iac.md)
for operation behavior, secrets, failure handling, and Deno/Terraform examples.
