# CoreWeave bucket access from notebooks (no long-lived keys)

Give a project's notebooks read/write access to a CoreWeave AI Object Storage
(CAIOS) bucket — e.g. `my-org-data` — **without creating any long-lived access
key**. MarimoHub becomes an OIDC issuer: per session it mints a short-lived,
project-scoped token, exchanges it server-side for **temporary** CAIOS
credentials, and injects them into the sandbox — they expire on their own.

This uses CoreWeave's
[OIDC Workload Identity Federation](https://docs.coreweave.com/docs/products/storage/object-storage/auth-access/workload-identity-federation/configure-wif-for-object-storage)
for Object Storage. Nothing is stored: not in the hub, not in the sandbox, not in
notebook code.

## How it works

1. The hub publishes an OIDC discovery document and a public JWKS at
   `/.well-known/openid-configuration` and `/.well-known/jwks.json`.
2. The deployment configures WIF (issuer + a named **federation target**); each
   **project opts in** by setting its `federation` (see "Enable it for a project").
3. On each session for an opted-in project `pid`, the hub mints a JWT with
   `sub = <pid>` (the project id) and a short expiry, signed with its WIF key.
4. The hub exchanges that JWT at the CAIOS endpoint (authenticated **by the JWT
   alone** — no caller credential) for temporary S3 credentials.
5. The temporary credentials are injected as `AWS_ACCESS_KEY_ID` /
   `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`; the notebook points an S3 client at
   the store (CAIOS is `https://cwobject.com`):

   ```python
   import boto3
   s3 = boto3.client("s3", endpoint_url="https://cwobject.com", region_name="us-east-04a")
   s3.list_objects_v2(Bucket="my-org-data")
   ```

`sub = <pid>` becomes the CoreWeave principal `role/<issuer>:<pid>`, so **which
project can reach which bucket is decided by the CAIOS access policy** — granting or
revoking access is a policy edit, no redeploy.

## One-time CoreWeave setup (operator)

Done in the CoreWeave Cloud Console — MarimoHub cannot automate it.

1. **Create an OIDC Workload Federation config** —
   [Administration → API Access → OIDC](https://console.coreweave.com/organization/iam/workload-federation/oidc):
   - **Issuer URL** = your hub's public origin, e.g. `https://hub.example.com`, with **no
     trailing slash** — it must match the token's `iss` exactly, and the hub emits the
     slash-free form. Must equal `MARIMOHUB_WIF_ISSUER_URL`.
   - **Client ID (Audience)** = a value of your choice, e.g. `coreweave-object-storage`
     (must equal `MARIMOHUB_WIF_AUDIENCE`).

   Your `MARIMOHUB_WIF_COREWEAVE_EXCHANGE_URL` is then
   `https://api.coreweave.com/v1/cwobject/temporary-credentials/oidc/<ORG-ID>` — the
   credential endpoint, **not** the `oidc.cks.coreweave.com/id/<uuid>` issuer URL the config
   also shows (that one only serves discovery + JWKS).

2. **Create one object-storage access policy** —
   [Object Storage → Access Policies](https://console.coreweave.com/object-storage/access-policies) —
   with two kinds of statement: one that lets the hub's roles mint credentials, and one per
   bucket a project may use.

   Principals are the role CoreWeave derives from each token, `role/<issuer>:<pid>` (note the
   `:` between issuer and project id). The mint statement uses the prefix form `role/<issuer>*`
   to cover every project; each bucket statement names an exact `role/<issuer>:<pid>`. A bare
   `role/<issuer>` or a `role/<issuer>/*` (slash) form does **not** match.

   <details>
   <summary>Example policy — mint + one bucket grant</summary>

   ```json
   {
   	"name": "marimohub-wif",
   	"version": "v1alpha1",
   	"statements": [
   		{
   			"name": "authn",
   			"effect": "Allow",
   			"actions": ["cwobject:CreateAccessKeyOIDC"],
   			"resources": ["*"],
   			"principals": ["role/https://hub.example.com*"]
   		},
   		{
   			"name": "access-proj-7h2k9qm4xz7rp3w8",
   			"effect": "Allow",
   			"actions": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
   			"resources": ["my-org-data", "my-org-data/*"],
   			"principals": ["role/https://hub.example.com:proj-7h2k9qm4xz7rp3w8"]
   		}
   	]
   }
   ```

   </details>

   The `authn` statement is required — without it the exchange returns nothing. Add a bucket
   statement per project that needs access; remove it to revoke. Find a project's `<pid>` in
   its URL or via the API.

### If the exchange fails

The broker records the reason in the `wif_exchange_error` log field (see `make logs`):

- **`Invalid token`** — CoreWeave rejected the JWT. Check the OIDC config's Issuer URL has no
  trailing slash and equals `MARIMOHUB_WIF_ISSUER_URL`, the audience matches, and the hub's
  JWKS is reachable at `<issuer>/.well-known/jwks.json`.
- **`permission denied`** — the JWT was accepted but the role isn't authorized. The access
  policy principal doesn't match `role/<issuer>:<pid>`: the mint statement needs
  `role/<issuer>*`, and the bucket statement needs the exact `role/<issuer>:<pid>`.

## Hub configuration

Set all of these together (a partial config fails fast at startup); leave them all
unset to disable the feature.

| Variable                               | Description                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MARIMOHUB_WIF_SIGNING_KEY`            | RSA private key (PKCS8 PEM). Generate with `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out wif.pem`. The public half is published at `/.well-known/jwks.json`. **Secret.** Secret stores synced as an env-file can't hold the multi-line PEM — pass its single-line base64 instead (`openssl base64 -A -in wif.pem`). |
| `MARIMOHUB_WIF_KID`                    | Key id surfaced in the JWT header and JWKS, e.g. `wif-2026-06`.                                                                                                                                                                                                                                                                          |
| `MARIMOHUB_WIF_ISSUER_URL`             | The hub's public origin, no trailing slash; must match the CoreWeave OIDC config's Issuer URL.                                                                                                                                                                                                                                           |
| `MARIMOHUB_WIF_AUDIENCE`               | Must match the CoreWeave OIDC config's Client ID / Audience.                                                                                                                                                                                                                                                                             |
| `MARIMOHUB_WIF_COREWEAVE_EXCHANGE_URL` | CoreWeave temporary-credentials endpoint, e.g. `https://api.coreweave.com/v1/cwobject/temporary-credentials/oidc/<ORG-ID>`. **Not** the `oidc.cks.coreweave.com/id/<uuid>` issuer URL.                                                                                                                                                   |
| `MARIMOHUB_WIF_STORAGE_ENDPOINT`       | S3 endpoint injected as `AWS_ENDPOINT_URL_S3`. Set for a non-AWS store (e.g. CoreWeave `cwobject.com`); omit for AWS S3. No fallback to `MARIMOHUB_STORAGE_S3_ENDPOINT`.                                                                                                                                                                 |
| `MARIMOHUB_WIF_STORAGE_REGION`         | Region injected as `AWS_REGION`. Set explicitly; no fallback to `MARIMOHUB_STORAGE_S3_REGION`.                                                                                                                                                                                                                                           |

The issuer URL must be reachable by CoreWeave so it can fetch the JWKS to validate
tokens. `MARIMOHUB_WIF_BROKER` (required; `coreweave`) selects the exchange broker.

## Enable it for a project

WIF is a deployment-wide _capability_; a project receives no credentials until a
project **admin** opts it in. Set the project's `federation` via the project
update API (`PUT /api/v1/projects/{pid}`):

```json
{ "federation": { "enabled": true, "target": "default" } }
```

- `enabled` — **when** to authenticate: `false`/omitted means no federated
  credentials, even while the deployment has WIF configured.
- `target` — **for what**: which registered federation target (and thus which
  cloud/bucket store). Omit to use `default`.

A project that is enabled but names an unregistered target starts without
credentials (logged, non-fatal). Actual bucket permission is still governed by the
CoreWeave access policy for `role/<issuer>:<pid>`.

## What the notebook receives

Before the kernel starts, the sandbox gets the temporary credentials as
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`. The notebook
passes the **endpoint and region explicitly** to its S3 client (as in the example
above) — they are deliberately not injected, so they can't clobber other S3/AWS
usage in the notebook.

Optionally, set `MARIMOHUB_WIF_STORAGE_ENDPOINT` / `MARIMOHUB_WIF_STORAGE_REGION`
to also inject `AWS_ENDPOINT_URL_S3` / `AWS_REGION` (S3-scoped — never the generic
`AWS_ENDPOINT_URL`). Then a plain `boto3.client("s3")` reaches the store, at the
cost of making it the default S3 endpoint/region for the whole notebook.

::: warning Credentials expire (~1h)
They are minted once per session and **not refreshed** — after ~1 hour they expire.
Restart the session to renew.
:::

## Security notes

- **No long-lived credentials** exist anywhere — the JWT is the only thing
  presented to CoreWeave, and the returned keys are short-lived.
- **Credentials are not refreshed mid-session** in this version: they last until
  their `Expiration`. Keep sessions shorter than the CAIOS credential lifetime, or
  restart the session to re-mint.
- **A federation/policy gap is non-fatal**: if the exchange fails (e.g. the project
  is not in the access policy), the notebook starts without bucket
  credentials rather than failing to launch.
- **Key rotation** is a swap-and-restart: set the new `MARIMOHUB_WIF_SIGNING_KEY`
  / `MARIMOHUB_WIF_KID` and restart the hub. The hub publishes a **single** key, so
  for a brief window after the swap — until CoreWeave re-fetches the JWKS — new
  exchanges signed with the new key may be rejected; those sessions just start
  without bucket credentials (non-fatal), and already-issued temporary credentials
  keep working until they expire. Rotate during low usage. (Zero-downtime rotation —
  publishing the new key alongside the old in a multi-key JWKS, then switching the
  active key — is a planned enhancement.)
