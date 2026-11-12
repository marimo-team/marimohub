# Integrations as code

Use `@marimo-hub/iac` to manage project integrations from TypeScript scripts.
It runs in Node 24.11+ and Deno 2.5+ with no runtime dependencies.

You need an existing project and a token with `integration.read` and `integration.manage`.
Use a [scoped PAT](./api-tokens.md) or an enabled [OIDC access token](./auth.md#external-access-tokens).
[Service accounts](./service-accounts.md) manage organization integrations only.

## Declare integrations

```ts
import { createHub, integration, secret } from '@marimo-hub/iac';

const integrations = createHub({
	url: 'https://hub.example.com',
	token: process.env.MARIMOHUB_TOKEN!,
}).project(process.env.MARIMOHUB_PROJECT_ID!).integrations;

const warehouse = integration('postgres', 'warehouse', {
	host: 'db.internal',
	database: 'analytics',
	username: 'reader',
	password: secret.ref('aws-sm', 'prod/warehouse#password'),
});

await integrations.upsert(warehouse);
```

TypeScript checks built-in configuration fields, required values, and nested choices.
The Hub checks runtime constraints and secret policies. For plain objects, use `satisfies IntegrationSpec`.

Supply the Hub URL without `/api/v1`. Deployment path prefixes are supported.
For renewable credentials, supply an async `token` callback.
The library does not read environment variables or print output.

## Choose an operation

| Operation      | Missing integration | Existing integration with the same name and kind |
| -------------- | ------------------- | ------------------------------------------------ |
| `insert(spec)` | Create              | Fail with a conflict                             |
| `ensure(spec)` | Create              | Keep the existing configuration                  |
| `upsert(spec)` | Create              | Update changes or keep equal configuration       |

A name identifies an integration within the project. A different kind with the same name causes a conflict.
Upsert replaces the full configuration. Omitted fields receive defaults or disappear, and `enabled` defaults to true.
A changed name creates another integration. Omitted integrations remain unchanged.

To override an inherited organization integration, pass `{ allowOrgOverride: true }`.
Otherwise, the name causes a conflict. A disabled override also shadows the organization integration.
The SDK never edits organization integrations.

Changes apply to future sessions. Existing sessions do not restart.

## Preview and apply

```ts
const plan = await integrations.plan([warehouse]);
console.log(plan.summary());
const result = await integrations.apply(plan);
```

Planning checks all declarations without storage writes. Apply requires each integration to match its planned revision.
If another writer changes an integration, apply fails. Create a new plan to review the new state.

Plans hold configuration in process memory. JSON reports contain metadata and changed field paths, but cannot serve as plans.
If approval occurs in another process, run planning again before apply.

Batches apply in order. A failure stops the batch and raises `ApplyError`.
Its `report` lists completed, failed, and not-attempted items. Completed operations remain committed.
Rerun upserts after a partial failure.

Direct `upsert` and `ensure` retry conflicts within an attempt limit and shared deadline.
If a response is lost, they check current state and can return `converged`.
A strict `insert` reports an uncertain outcome instead. Inspect the integration before another insert attempt.

## Secrets

| Declaration                    | Behavior                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------ |
| `secret.ref(backend, locator)` | Uses a configured external resolver. The Hub compares the reference without fetching its value.  |
| Inline string                  | Uses managed encryption. Repeated equal values do not create a version.                          |
| `secret.keep()`                | Preserves an existing managed secret, including named array entries. Fails for an absent secret. |

External rotation does not create a configuration version. Resolver policy must allow access for the project.
Planning does not test connections or resolve external secrets.
See [integration secrets](./integration-secrets.md) for resolver configuration.

Reports omit values and locators. Keep raw declarations and credentials out of logs.

## Deno and pipelines

Copy [the Deno example](https://github.com/marimo-team/marimohub/tree/main/examples/integration-iac/deno).
Its `deno.json` pins the package version, which must exist on npm.
Run `deno install`. Commit `deno.lock`. Then run:

```sh
deno check integrations.ts
deno task plan
deno task apply
```

Supply `MARIMOHUB_URL`, `MARIMOHUB_TOKEN`, `MARIMOHUB_PROJECT_ID`, and `WAREHOUSE_HOST` through the environment.
The Hub resolves the secret reference, so the script needs no AWS credentials.

The tasks use a frozen lockfile, disable prompts, and allow only named environment variables.
For a fixed deployment, restrict `--allow-net` to `--allow-net=hub.example.com`.
Cache dependencies before an offline run.

`@marimo-hub/iac/runner` accepts environment and output callbacks and returns an exit code.

| Mode          | Exit codes                                |
| ------------- | ----------------------------------------- |
| Default apply | 0 on success, 1 on failure                |
| `--plan`      | 0 for a valid plan, 1 on failure          |
| `--check`     | 0 for no drift, 2 for drift, 1 on failure |

Add `--json` for structured stdout. Diagnostics go to stderr.

Run the script after infrastructure provisioning and before application rollout:

- In CI, inject the token through the secret facility.
- In a startup script, call `deno task apply` after the Hub is ready.
- In a Kubernetes Job, mount the script and supply the token through a Secret environment variable.

## Terraform hook

Copy [the Terraform example](https://github.com/marimo-team/marimohub/tree/main/examples/integration-iac/terraform)
with the adjacent Deno directory. Commit the Deno lockfile before Terraform reads its hash.
Pass the Hub URL, project ID, and database host as resource outputs to establish dependencies.
Wait for Hub readiness before execution. Inject `MARIMOHUB_TOKEN` through the runner environment to keep it outside Terraform state.

The `terraform_data` hook runs on creation or a declared trigger change.
`terraform plan` does not detect Hub drift. Use scheduled `--check` runs or explicit resource replacement.
`terraform destroy` does not delete integrations.

## Custom kinds

```ts
const custom = integration.custom('company_connector', 'analytics', config, (value) => {
	validateCompanyConfig(value);
});
await integrations.upsert(custom);
```

Your validator checks the custom configuration. The Hub also checks its registered kind.
The separate helper prevents misspelled built-in kinds from becoming untyped declarations.
