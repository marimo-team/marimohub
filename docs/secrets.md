# Project secrets

Let a **project admin** register a third-party key — `OPENAI_API_KEY`, a database
password — that the hub injects into every notebook sandbox in that project as an
environment variable. Notebook code reads it from `os.environ` instead of pasting
it into a cell.

Optional and **off by default**: when disabled, the routes 404 and nothing is
injected.

> Prefer [Workload Identity Federation](./coreweave-bucket-access.md) whenever the
> credential is federatable (object storage, and more cloud APIs over time):
> federation mints a short-lived credential on demand, so there is no key for the
> hub to hold or leak at all.

## Two kinds of entry

Every entry is an env-var `name` plus one of:

- **`reference` (recommended)** — the value stays in **your** secret manager (AWS
  Secrets Manager today; GCP / Vault to follow). The hub stores only a pointer
  (`{ backend, locator }`) and reads the value at session launch with **read-only**
  access. The hub never holds your secret at rest. A reference can point at one
  value, or (with **expand JSON**) at a JSON-object secret whose every key becomes
  its own env var — store a whole bundle once. "Test" dry-runs a reference so a
  bad locator surfaces before it fails a session.
- **`managed`** — the hub holds the value, encrypted-in-bucket. Convenient, but the
  hub now stores your ciphertext **and** the key that decrypts it, so a hub
  compromise exposes the secret. Opt-in only, and **not enabled by default** (it
  requires a separately-configured codec).

> **Default to references.** Keep secrets in a manager you already run and let the
> hub reference them; reserve `managed` for cases where you have no external manager
> and accept the higher blast radius. See [Security model](#security-model).

The stable contract is **the env-var names injected into the sandbox**. Moving an
entry between kinds or managers changes its `backend`/`locator` under the same
`name` — the notebook is untouched.

## Configuration

| Variable                    | Description                                                   |
| --------------------------- | ------------------------------------------------------------- |
| `MARIMOHUB_SECRETS_BACKEND` | `none` (default) or `bucket` (persist entries in the bucket). |

Set `bucket`, then register an external-manager backend below to resolve
references. See [AWS Secrets Manager](#aws-secrets-manager) for `MARIMOHUB_SECRETS_AWS_*`.

## Security model

- **Managed values are write-only.** No API ever returns a `managed` value — `list`
  returns names, kinds, and (for references) the non-sensitive locator. Once set, a
  value can only be overwritten or deleted.
- **Resolution fails a session closed.** If a configured secret can't be resolved
  (manager unreachable, access denied, key absent), session create **fails** with a
  non-leaking error naming the entry — a notebook that expects `OPENAI_API_KEY` must
  not start pretending it has one. (This diverges from federated bucket access,
  which is best-effort.)
- **Secrets can't shadow the hub's env or hijack the runtime.** Names must be
  POSIX-safe upper-snake and are rejected if they collide with hub-injected
  variables (`AWS_*`, `MARIMO*`, `PATH`, …) or are process-startup code-execution
  vectors (`LD_PRELOAD`, `PYTHONSTARTUP`, `NODE_OPTIONS`, …). A hub-managed var also
  wins any name collision at injection time.
- **Never injected into a viewer's ephemeral sandbox**, and **never logged**
  (values or locators).
- **Deliberately mutable, last-writer-wins** (no version history). Overwriting keeps
  `created_at`/`created_by` and bumps `updated_at`. Reclaimed on project delete.

**Authorization:** `list` requires `viewer`+ (metadata only); create / overwrite /
delete require `admin`.

## AWS Secrets Manager

A `reference` with `backend = aws-sm` points at a secret in your AWS account; the
hub uses `secretsmanager:GetSecretValue` only — never a write. Enable by setting a
region (or `MARIMOHUB_SECRETS_AWS=true` when the region is ambient); credentials
default to the AWS provider chain (IRSA / ECS task role / instance profile /
ambient env), so AWS-hosted deployments need no static key.

| Variable                                  | Description                                                      |
| ----------------------------------------- | ---------------------------------------------------------------- |
| `MARIMOHUB_SECRETS_AWS_REGION`            | AWS region (required by the SDK if not ambient). Enables aws-sm. |
| `MARIMOHUB_SECRETS_AWS`                   | `true` to enable without a region env var.                       |
| `MARIMOHUB_SECRETS_AWS_ACCESS_KEY_ID`     | Static-credential override for non-AWS hosts; omit on AWS.       |
| `MARIMOHUB_SECRETS_AWS_SECRET_ACCESS_KEY` | Paired with the access key id (all-or-nothing).                  |
| `MARIMOHUB_SECRETS_AWS_CACHE_TTL_SECONDS` | Resolve-cache TTL; `0` (default) disables it.                    |
| `MARIMOHUB_SECRETS_AWS_ROLE_ARN`          | Reserved for future OIDC federation. Not implemented.            |

Grant the hub only `secretsmanager:GetSecretValue` on the intended ARNs. A locator
is `secret-id-or-arn[#json-key]`:

- `prod/openai` → the secret string verbatim.
- `prod/ai#OPENAI_API_KEY` → one field of a JSON secret.
- `prod/ai` with **expand JSON** → every field of the JSON secret, one env var each.
- `arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/ai-AbCdEf#key` → a
  field addressed by full ARN.

Sibling `#key` selections and a JSON expansion of the same secret share one
`GetSecretValue` call (a short in-memory cache, off by default).

### Failure modes

| Symptom                    | Cause                                    | Fix                                          |
| -------------------------- | ---------------------------------------- | -------------------------------------------- |
| `secret_resolution_failed` | Manager unreachable / access denied      | Check network + the `GetSecretValue` grant.  |
| `... no JSON key ...`      | `id#key` names a missing field           | Fix the `#key` or the secret's JSON payload. |
| `unknown secret backend`   | Entry references an unregistered backend | Configure that backend, or re-point it.      |
