# Workload Identity Federation

Give a project's notebooks access to cloud resources **without creating any long-lived access key**.
marimohub becomes an OIDC issuer: per session it mints a short-lived,
project-scoped token and exchanges it server-side for **temporary** cloud
credentials, which it injects into the sandbox — they expire on their own.
Nothing is stored: not in the hub, not in the sandbox, not in notebook code.

The cloud side is selected by a **broker** (`MARIMOHUB_WIF_BROKER`):

| Broker      | Cloud                                 | What the notebook can reach                            |
| ----------- | ------------------------------------- | ------------------------------------------------------ |
| `coreweave` | CoreWeave AI Object Storage (CAIOS)   | Buckets granted by the CAIOS access policy             |
| `aws`       | AWS (STS `AssumeRoleWithWebIdentity`) | Anything the assumed role allows — S3, Athena, Glue, … |

GCP is planned — see [the GCP example](#example-gcp-gcs-bigquery).

## How it works

1. The hub publishes an OIDC discovery document and a public JWKS at
   `/.well-known/openid-configuration` and `/.well-known/jwks.json`. The issuer
   URL must be reachable by the cloud so it can fetch the JWKS to validate
   tokens.
2. The deployment configures WIF (issuer + a **federation target**); each
   **project opts in** by setting its `federation` (see "Enable it for a
   project").
3. On each session for an opted-in project `pid`, the hub mints a JWT with
   `sub = <pid>` (the project id) and a short expiry, signed with its WIF key.
4. The broker exchanges that JWT with the cloud (authenticated **by the JWT
   alone** — no caller credential) for temporary credentials.
5. The temporary credentials are injected into the sandbox as
   `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` before
   the kernel starts.

Because `sub` is the project id, **which project can reach what is decided by
the cloud's policy** (a CAIOS access policy, an IAM trust policy) — granting or
revoking access is a policy edit, no redeploy. If an exchange fails, the reason
is recorded in the `wif_exchange_error` log field and the notebook starts
without federated credentials rather than failing to launch.

## Hub configuration

Set all of these together (a partial config fails fast at startup); leave them
all unset to disable the feature. Broker-specific variables are listed in each
example below; the full reference is
[Configuration → Workload Identity Federation](./configuration.md#workload-identity-federation).

| Variable                         | Description                                                                                                                                                                                                                                                                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MARIMOHUB_WIF_SIGNING_KEY`      | RSA private key (PKCS8 PEM). Generate with `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out wif.pem`. The public half is published at `/.well-known/jwks.json`. **Secret.** Secret stores synced as an env-file can't hold the multi-line PEM — pass its single-line base64 instead (`openssl base64 -A -in wif.pem`). |
| `MARIMOHUB_WIF_KID`              | Key id surfaced in the JWT header and JWKS, e.g. `wif-2026-06`.                                                                                                                                                                                                                                                                          |
| `MARIMOHUB_WIF_ISSUER_URL`       | The hub's public origin, no trailing slash; must match the Issuer URL configured in the cloud's WIF / identity-provider config.                                                                                                                                                                                                          |
| `MARIMOHUB_WIF_AUDIENCE`         | The `aud` claim; must match the Audience / Client ID configured on the cloud side.                                                                                                                                                                                                                                                       |
| `MARIMOHUB_WIF_BROKER`           | Which broker exchanges the JWT: `coreweave` or `aws`.                                                                                                                                                                                                                                                                                    |
| `MARIMOHUB_WIF_STORAGE_ENDPOINT` | S3 endpoint injected as `AWS_ENDPOINT_URL_S3`. Set for a non-AWS store (e.g. CoreWeave `cwobject.com`); omit for AWS S3. No fallback to `MARIMOHUB_STORAGE_S3_ENDPOINT`.                                                                                                                                                                 |
| `MARIMOHUB_WIF_STORAGE_REGION`   | Region injected as `AWS_REGION`. Set explicitly; no fallback to `MARIMOHUB_STORAGE_S3_REGION`.                                                                                                                                                                                                                                           |

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
  cloud). Omit to use `default`.

A project that is enabled but names an unregistered target starts without
credentials (logged, non-fatal). Actual resource permission is still governed by
the cloud-side policy for that project's `sub`.

## What the notebook receives

Before the kernel starts, the sandbox gets the temporary credentials as
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` — the
standard variables every AWS SDK (and S3-compatible client) reads.

Optionally, set `MARIMOHUB_WIF_STORAGE_ENDPOINT` / `MARIMOHUB_WIF_STORAGE_REGION`
to also inject `AWS_ENDPOINT_URL_S3` / `AWS_REGION` (S3-scoped — never the
generic `AWS_ENDPOINT_URL`). Then a plain `boto3.client("s3")` reaches the
store, at the cost of making it the default S3 endpoint/region for the whole
notebook.

::: warning Credentials expire (~1h)
They are minted once per session and **not refreshed** — after ~1 hour they
expire. Restart the session to renew.
:::

## Example: CoreWeave Object Storage (Automatic)

On the `coreweave` compute backend, the Sandbox platform vends CAIOS
credentials itself: created with `object_storage_access`, a sandbox gets a
per-sandbox OIDC token from the Sandbox Gateway and a credential-vending
sidecar that exchanges it for temporary S3 credentials. The hub never signs or
exchanges anything.

|                 | Automatic                           | Manual (hub-minted)                  |
| --------------- | ----------------------------------- | ------------------------------------ |
| Compute backend | `coreweave` only                    | any                                  |
| Credentials     | auto-refresh for the sandbox's life | minted once per session, expire ~1h  |
| Scope           | one bucket list for the deployment  | per project, via access policy       |
| Hub setup       | none — no signing key or JWKS       | signing key + `MARIMOHUB_WIF_*` vars |

This is the Sandbox analogue of CoreWeave's
[Pod Identity Webhook](https://docs.coreweave.com/security/tutorials/cks-object-storage-authentication/automatic)
for CKS pods. The webhook itself keys off a ServiceAccount annotation, so it
applies only where you control the ServiceAccount — the `kubernetes` compute
backend (`MARIMOHUB_COMPUTE_KUBERNETES_SERVICE_ACCOUNT`) or the hub's own
Deployment — never to Sandbox-runner pods.

### One-time setup (operator)

1. **Create an OIDC Workload Federation config** —
   [Administration → API Access → OIDC](https://console.coreweave.com/organization/iam/workload-federation/oidc) —
   with **Issuer URL** `https://oidc.cwsandbox.com` (the Sandbox Gateway's OIDC
   issuer; discovery + JWKS live at
   `https://oidc.cwsandbox.com/.well-known/openid-configuration`). Note the
   resulting WIF config id.
2. **Create an object-storage access policy for the gateway issuer** —
   [Object Storage → Access Policies](https://console.coreweave.com/object-storage/access-policies),
   or `POST https://api.coreweave.com/v1/cwobject/access-policy` with the
   policy wrapped as `{"policy": …}`. CoreWeave authorizes each exchange
   against the principal it derives from the token, `role/<issuer>:<sub>`;
   the `sub` is per-sandbox, so both statements use the prefix form
   `role/https://oidc.cwsandbox.com*` (the same matching rules as Manual WIF
   apply: a bare `role/<issuer>` or slash form does **not** match).

   <details>
   <summary>Example policy — mint + one bucket grant</summary>

   ```json
   {
   	"name": "sandbox-native-wif",
   	"version": "v1alpha1",
   	"statements": [
   		{
   			"name": "authn",
   			"effect": "Allow",
   			"actions": ["cwobject:CreateAccessKeyOIDC"],
   			"resources": ["*"],
   			"principals": ["role/https://oidc.cwsandbox.com*"]
   		},
   		{
   			"name": "bucket-access",
   			"effect": "Allow",
   			"actions": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
   			"resources": ["my-org-data", "my-org-data/*"],
   			"principals": ["role/https://oidc.cwsandbox.com*"]
   		}
   	]
   }
   ```

   </details>

   Without this policy the token validates but the exchange is refused, and
   SDK calls inside the sandbox fail with `403 permission denied` from the
   `container-role` credential provider.
3. **Register the config with the Sandbox Gateway** (idempotent upsert; scoped
   to your org by the API key):

   ```sh
   curl -X PUT https://api.cwsandbox.com/v1beta2/object-storage/wif-config \
     -H "Authorization: Bearer $CWSANDBOX_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{
       "wifConfigId": "<WIF-CONFIG-ID>",
       "allowedBuckets": ["my-org-data"],
       "maxPermission": "OBJECT_STORAGE_PERMISSION_READ_WRITE"
     }'
   ```

   An empty `allowedBuckets` allows all buckets; `maxPermission` caps every
   sandbox grant. Without this config, sandbox creates that request
   `object_storage_access` fail with `CWSANDBOX_RESOURCE_NOT_FOUND`.

### Hub configuration (Automatic)

```sh
MARIMOHUB_COMPUTE_BACKEND=coreweave
MARIMOHUB_COMPUTE_COREWEAVE_OBJECT_STORAGE_BUCKETS=my-org-data
# Optional: read | read-write (default read-write, capped by maxPermission).
MARIMOHUB_COMPUTE_COREWEAVE_OBJECT_STORAGE_PERMISSION=read-write
# Optional: injected as AWS_ENDPOINT_URL_S3 / AWS_REGION so plain SDK clients
# target CAIOS without per-call configuration.
MARIMOHUB_COMPUTE_COREWEAVE_OBJECT_STORAGE_ENDPOINT=https://cwobject.com
MARIMOHUB_COMPUTE_COREWEAVE_OBJECT_STORAGE_REGION=us-east-04a
```

CoreWeave documents `http://cwlota.com` (LOTA) as the accelerated in-cluster
endpoint — since sandboxes run on CoreWeave infrastructure, try it as the
endpoint once the org setup is live. CAIOS requires virtual-hosted addressing
with either endpoint (boto3 handles this; the AWS CLI needs
`aws configure set s3.addressing_style virtual`).

Setting the bucket list on the `coreweave` backend disables Manual WIF
(logged as `wif_disabled_sandbox_native_storage`): the hub's static
`AWS_ACCESS_KEY_ID` env would take precedence over the sidecar in the AWS
credential chain and stop refresh.

## Example: CoreWeave Object Storage (Manual)

Give notebooks read/write access to a CoreWeave AI Object Storage (CAIOS)
bucket — e.g. `my-org-data` — using CoreWeave's
[OIDC Workload Identity Federation](https://docs.coreweave.com/docs/products/storage/object-storage/auth-access/workload-identity-federation/configure-wif-for-object-storage)
for Object Storage.

### One-time CoreWeave setup (operator)

Done in the CoreWeave Cloud Console — marimohub cannot automate it.

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

### Hub configuration (CoreWeave)

Besides the generic variables above:

```sh
MARIMOHUB_WIF_BROKER=coreweave
MARIMOHUB_WIF_COREWEAVE_EXCHANGE_URL=https://api.coreweave.com/v1/cwobject/temporary-credentials/oidc/<ORG-ID>
```

Set `MARIMOHUB_WIF_STORAGE_ENDPOINT=https://cwobject.com` (and a region) to let
notebooks use a plain `boto3.client("s3")`, or leave them unset and pass the
endpoint explicitly:

```python
import boto3
s3 = boto3.client("s3", endpoint_url="https://cwobject.com", region_name="us-east-04a")
s3.list_objects_v2(Bucket="my-org-data")
```

### If the exchange fails

Check the `wif_exchange_error` log field:

- **`Invalid token`** — CoreWeave rejected the JWT. Check the OIDC config's Issuer URL has no
  trailing slash and equals `MARIMOHUB_WIF_ISSUER_URL`, the audience matches, and the hub's
  JWKS is reachable at `<issuer>/.well-known/jwks.json`.
- **`permission denied`** — the JWT was accepted but the role isn't authorized. The access
  policy principal doesn't match `role/<issuer>:<pid>`: the mint statement needs
  `role/<issuer>*`, and the bucket statement needs the exact `role/<issuer>:<pid>`.

## Example: AWS (S3 + Athena)

Give notebooks access to an S3 bucket **and** Athena queries with the same
temporary credentials. The hub exchanges its JWT at AWS STS
(`AssumeRoleWithWebIdentity`) for credentials of an IAM role you create — so the
notebook can call **any AWS API that role's policies allow**, not only S3.

### One-time AWS setup (operator)

1. **Create an IAM OIDC identity provider** (IAM → Identity providers → Add
   provider → OpenID Connect):
   - **Provider URL** = your hub's public origin, e.g. `https://hub.example.com`
     (must equal `MARIMOHUB_WIF_ISSUER_URL`; AWS fetches
     `<issuer>/.well-known/openid-configuration` to validate it).
   - **Audience** = a value of your choice, e.g. `sts.amazonaws.com` (must equal
     `MARIMOHUB_WIF_AUDIENCE`).

2. **Create an IAM role** whose trust policy trusts that provider. The condition
   keys are prefixed with the provider URL **without the scheme**. Pin `aud`,
   and use `sub` to control **which projects** may assume the role — exact
   project ids, or `StringLike` with `proj-*` for all:

   ```json
   {
   	"Version": "2012-10-17",
   	"Statement": [
   		{
   			"Effect": "Allow",
   			"Principal": {
   				"Federated": "arn:aws:iam::123456789012:oidc-provider/hub.example.com"
   			},
   			"Action": "sts:AssumeRoleWithWebIdentity",
   			"Condition": {
   				"StringEquals": {
   					"hub.example.com:aud": "sts.amazonaws.com",
   					"hub.example.com:sub": "proj-7h2k9qm4xz7rp3w8"
   				}
   			}
   		}
   	]
   }
   ```

   ::: tip One role for the whole deployment
   The hub exposes a single role today, so every opted-in project receives the
   **same** permissions. Use the trust-policy `sub` condition to limit which
   projects can assume it — a project outside the condition starts without
   credentials (non-fatal).
   :::

3. **Attach permission policies** for what notebooks may do. For S3 + Athena:

   <details>
   <summary>Example permissions — one data bucket + Athena queries</summary>

   ```json
   {
   	"Version": "2012-10-17",
   	"Statement": [
   		{
   			"Sid": "DataBucket",
   			"Effect": "Allow",
   			"Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
   			"Resource": ["arn:aws:s3:::my-org-data", "arn:aws:s3:::my-org-data/*"]
   		},
   		{
   			"Sid": "AthenaQueries",
   			"Effect": "Allow",
   			"Action": [
   				"athena:StartQueryExecution",
   				"athena:GetQueryExecution",
   				"athena:GetQueryResults"
   			],
   			"Resource": "arn:aws:athena:us-east-1:123456789012:workgroup/primary"
   		},
   		{
   			"Sid": "GlueCatalogRead",
   			"Effect": "Allow",
   			"Action": ["glue:GetDatabase", "glue:GetTable", "glue:GetTables", "glue:GetPartitions"],
   			"Resource": "*"
   		},
   		{
   			"Sid": "AthenaResults",
   			"Effect": "Allow",
   			"Action": ["s3:GetObject", "s3:PutObject", "s3:GetBucketLocation", "s3:ListBucket"],
   			"Resource": ["arn:aws:s3:::my-athena-results", "arn:aws:s3:::my-athena-results/*"]
   		}
   	]
   }
   ```

   </details>

### Hub configuration (AWS)

Besides the generic variables above:

```sh
MARIMOHUB_WIF_BROKER=aws
MARIMOHUB_WIF_AWS_ROLE_ARN=arn:aws:iam::123456789012:role/marimohub-wif
# Optional; defaults to the global endpoint. Regional is recommended by AWS.
MARIMOHUB_WIF_AWS_STS_URL=https://sts.us-east-1.amazonaws.com
# AWS S3 needs no endpoint override — leave MARIMOHUB_WIF_STORAGE_ENDPOINT unset.
MARIMOHUB_WIF_STORAGE_REGION=us-east-1
```

The role's session name is the project id, so CloudTrail attributes every API
call to the project that made it.

### In the notebook

The injected credentials are the standard `AWS_*` variables, so every AWS SDK
picks them up with no configuration — the same session drives S3 and Athena:

```python
import time
import boto3

s3 = boto3.client("s3")
s3.list_objects_v2(Bucket="my-org-data")

athena = boto3.client("athena")
query = athena.start_query_execution(
    QueryString="SELECT * FROM events LIMIT 10",
    QueryExecutionContext={"Database": "analytics"},
    ResultConfiguration={"OutputLocation": "s3://my-athena-results/"},
)
qid = query["QueryExecutionId"]
while True:
    status = athena.get_query_execution(QueryExecutionId=qid)["QueryExecution"]["Status"]
    if status["State"] not in ("QUEUED", "RUNNING"):
        break
    time.sleep(1)
assert status["State"] == "SUCCEEDED", status.get("StateChangeReason", status["State"])
rows = athena.get_query_results(QueryExecutionId=qid)["ResultSet"]["Rows"]
```

### If the exchange fails

Check the `wif_exchange_error` log field for the STS error code:

- **`InvalidIdentityToken`** — STS rejected the JWT. Check the identity
  provider's URL equals `MARIMOHUB_WIF_ISSUER_URL` (no trailing slash), the
  audience matches, and the hub's JWKS is publicly reachable at
  `<issuer>/.well-known/jwks.json`.
- **`AccessDenied`** — the JWT was accepted but the trust policy refused it: the
  `aud` condition doesn't match `MARIMOHUB_WIF_AUDIENCE`, or the project's
  `sub` isn't covered by the `sub` condition.

## Example: GCP (GCS + BigQuery)

::: warning Not yet supported
No `gcp` broker ships yet — this section describes the planned setup so you can
evaluate it, not configure it. GCP's token exchange
(`sts.googleapis.com`) returns an OAuth access token rather than the
`AWS_ACCESS_KEY_ID`-style keys the current pipeline injects, so it needs a new
credential shape in the hub, not only a policy on the cloud side.
:::

The analogous setup mirrors AWS:

1. Create a **Workload Identity Pool** with an **OIDC provider** pointed at the
   hub (issuer = `MARIMOHUB_WIF_ISSUER_URL`, allowed audience =
   `MARIMOHUB_WIF_AUDIENCE`), mapping `google.subject` to `assertion.sub` (the
   project id).
2. Grant the pool principal
   (`principal://iam.googleapis.com/…/subject/<pid>`) access directly or via
   service-account impersonation — e.g. `roles/storage.objectAdmin` on a GCS
   bucket and `roles/bigquery.jobUser` + `roles/bigquery.dataViewer` for
   queries.
3. The notebook would then reach GCS and BigQuery through the standard
   `google-cloud-*` clients.

## Security notes

- **No long-lived credentials** exist anywhere — the JWT is the only thing
  presented to the cloud, and the returned credentials are short-lived.
- **Credentials are not refreshed mid-session** in this version: they last until
  their expiration (~1h). Keep sessions shorter than the credential lifetime, or
  restart the session to re-mint.
- **A federation/policy gap is non-fatal**: if the exchange fails (e.g. the
  project is not covered by the cloud-side policy), the notebook starts without
  federated credentials rather than failing to launch.
- **Key rotation** is a swap-and-restart: set the new `MARIMOHUB_WIF_SIGNING_KEY`
  / `MARIMOHUB_WIF_KID` and restart the hub. The hub publishes a **single** key, so
  for a brief window after the swap — until the cloud re-fetches the JWKS — new
  exchanges signed with the new key may be rejected; those sessions just start
  without federated credentials (non-fatal), and already-issued temporary
  credentials keep working until they expire. Rotate during low usage.
  (Zero-downtime rotation — publishing the new key alongside the old in a
  multi-key JWKS, then switching the active key — is a planned enhancement.)
