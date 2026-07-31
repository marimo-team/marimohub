---
description: Connect data sources to a project — Postgres, PyIceberg catalogs, Trino, PySpark, custom env — rendered into every notebook sandbox.
---

# Project integrations

Let a **project admin** connect a data source once — a PostgreSQL database, a
PyIceberg catalog, a Trino cluster, Spark Connect, or arbitrary environment variables — and
every notebook session in that project receives its **connection config**,
rendered into environment variables and files inside the sandbox at launch.
Notebook code never sees the hub's API or storage. The hub injects config, not
Python libraries: each kind lists the packages its contract assumes (below),
which you add to the notebook's dependencies like any other package.

Opt-in: set `MARIMOHUB_INTEGRATIONS=on` (unset/`off` = the routes 404 and
nothing is injected). Enable it only once **every** replica runs a release that
preserves unknown session fields — during a mixed-version rolling deploy an
older replica's heartbeat would strip the session's integration audit pin (the
two-phase policy in `development_docs/migrations.md`). Configs are
**versioned**: every save appends an immutable revision, and each session
records exactly which revisions it launched with.

## Using an integration in a notebook

Each _kind_ documents its sandbox contract in the add-integration form. In v1:

| Kind                           | What the sandbox gets                                                                                                                                                                                                                                                                          |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PostgreSQL**                 | `MARIMOHUB_PG_<NAME>_URL` (a SQLAlchemy-ready `postgresql://…` URL) plus `_HOST/_PORT/_DATABASE/_USER/_PASSWORD`, and a secret-free descriptor at `$MARIMOHUB_INTEGRATIONS_DIR/postgres/<name>.json`.                                                                                          |
| **Iceberg REST Catalog**       | A PyIceberg catalog supporting no auth, bearer tokens, Basic, OAuth2 client credentials, AWS SigV4, Google ADC/service accounts, and Entra; REST/TLS tuning; access delegation; and documented remote FileIO families.                                                                         |
| **Iceberg SQL Catalog**        | PostgreSQL or SQLite catalog metadata, including SQLAlchemy initialization, liveness, and logging options. The SQLAlchemy URI is encrypted because it commonly embeds credentials.                                                                                                             |
| **Iceberg Hive Catalog**       | Hive Metastore Thrift connection, Hive 2 compatibility, Kerberos, UGI, and FileIO configuration.                                                                                                                                                                                               |
| **Iceberg AWS Glue Catalog**   | Glue catalog/account/endpoint/retry configuration with ambient, profile, encrypted static, or shared catalog/FileIO AWS credentials.                                                                                                                                                           |
| **Iceberg DynamoDB Catalog**   | DynamoDB table/region configuration with ambient, profile, encrypted static, or shared catalog/FileIO AWS credentials.                                                                                                                                                                         |
| **Iceberg BigQuery Metastore** | BigQuery project/location configuration with ADC or encrypted service-account JSON and independent FileIO configuration.                                                                                                                                                                       |
| **Trino**                      | `MARIMOHUB_TRINO_<NAME>_URL` plus connection env vars and `trino/<name>.json`. Supports Basic, JWT, OAuth2, client certificates, Kerberos, GSSAPI, TLS verification, headers, extra credentials, roles, session properties, spooling, retries, timeouts, isolation, and compatibility options. |
| **PySpark (Spark Connect)**    | `MARIMOHUB_PYSPARK_<NAME>_REMOTE`, optional `_TOKEN`, and `pyspark/<name>.json` with the SparkSession settings. Supports token auth, user identity, gRPC keepalive/metadata, and plain or encrypted Spark configuration.                                                                       |
| **Custom environment**         | Exactly the env vars you configure — plain or secret.                                                                                                                                                                                                                                          |

All Iceberg kinds are written into
`$MARIMOHUB_INTEGRATIONS_DIR/.pyiceberg.yaml`; `PYICEBERG_HOME` points there,
so `pyiceberg.catalog.load_catalog("<name>")` works directly. The typed storage
selector covers catalog-provided credentials, S3/compatible stores, GCS, ADLS,
HDFS, and Hugging Face. Process-wide worker/compatibility settings and PyArrow
read behavior are also typed. Non-secret PyIceberg options that are not
first-class fields remain available through `extra_properties`;
credential-shaped keys are rejected there so secrets cannot bypass encryption.

PyIceberg's in-memory catalog is intentionally not an integration kind: the
official documentation describes it as non-concurrent test/demo state, so it
cannot serve as a reusable project data source. Custom catalog implementations
and custom REST authentication managers are also excluded because accepting an
arbitrary Python class path would turn configuration into code loading.

`<NAME>` is the integration's instance name upper-cased with `-` → `_`
(`prod` → `PROD`). Example:

```python
import os
import sqlalchemy

engine = sqlalchemy.create_engine(os.environ["MARIMOHUB_PG_PROD_URL"])
```

For PySpark, pass the named remote URL to `SparkSession.builder.remote()`, then
apply the settings from the JSON descriptor before calling `getOrCreate()`.
This integration targets Spark Connect. Provisioning a classic Spark driver or
cluster remains the compute backend's responsibility.

Each kind declares the Python packages its contract assumes (shown on the kind
card, e.g. `sqlalchemy>=2, psycopg2-binary>=2.9` for PostgreSQL, `pyiceberg` for
Iceberg) and echoes them into `manifest.json`. Add them to the notebook's
dependencies like any other package — the hub injects connection config, not
Python libraries.

Every session also gets `MARIMOHUB_INTEGRATIONS_DIR` (default
`/tmp/marimohub-integrations`) containing each integration's rendered files and
a `manifest.json` naming the instances, kinds, and config versions in play. The
directory sits outside the workspace, so rendered config is never captured back
into the notebook's files.

### PostgreSQL and TLS

New PostgreSQL integrations default to libpq's `verify-full`, which checks both
the certificate chain and the hostname. libpq does not consult the system trust
store on its own — with no `sslrootcert` it looks for `~/.postgresql/root.crt`
and fails when that file is absent — so the rendered URL points `sslrootcert` at
the sandbox image's CA bundle (`/etc/ssl/certs/ca-certificates.crt`). A publicly
trusted server therefore verifies with no extra setup. For a private CA, paste
its PEM into **CA bundle**; it is written beside the integration's other files
and `sslrootcert` points there instead. `require` encrypts but authenticates
nothing — choose it deliberately. A custom sandbox image must ship
`ca-certificates`, or every integration needs its own CA bundle.

## Managing integrations

Open a project → the **integrations** icon in the header. Members (`viewer`+)
can see the list and redacted configs; **`admin`** manages them — as does a
[super admin](./auth.md#super-admins-marimohub_super_admins), on every project.

- **Add** — pick a kind from the catalog; the form is generated from the kind's
  schema (conditional sections switch with the auth method). **Test** probes
  connectivity server-side for kinds that support it (Iceberg, Trino) before you
  save. Because the probe is a server-side request to an admin-supplied address,
  it runs behind an egress policy: by default only public addresses are allowed
  (private, loopback, link-local/metadata ranges are rejected; redirects are
  never followed; responses are size- and time-capped; probes are rate-limited).
  Set `MARIMOHUB_INTEGRATIONS_PROBE=private` if your catalogs/engines live on a
  private network, or `off` to disable testing.
- **Edit** — a new immutable config version is appended; the version history is
  listed under `GET …/integrations/{iid}/versions`. Stored secret values show as
  `•••••••• (set)` and are kept unless you replace them — never re-entered,
  never displayed.
- **Enable / disable** — disabled integrations are skipped at session launch.
  This is also the escape hatch when a broken config is failing sessions.
- **Delete** — removes the instance and its entire version history.

New sessions pick up config changes; running sessions keep what they launched
with (restart the session to apply).

## Secret fields

Secret config fields (passwords, tokens) are encrypted at rest with the
deployment's managed-secret KEK and never returned by any API — responses show
`{ "$secret": { "set": true } }`. Set `MARIMOHUB_SECRETS_KEK` to enable them — a
generated 32-byte key, i.e. the exact output of `openssl rand -base64 32` (43
base64 characters) or `openssl rand -hex 32` (64 hex characters). A passphrase,
or any value not shaped like a generated key, is rejected at startup, because
the hub applies no password stretching to it. Without a KEK, only secret-free
configs can be saved and the error names the missing variable. The KEK is shared
with [managed project secrets](./secrets.md).

## Failure model

Like [project secrets](./secrets.md), integration rendering **fails a session
closed**: if a configured, enabled integration cannot render (secret undecryptable,
config no longer valid for its kind), session create fails with a non-leaking
error naming the instance — a notebook expecting `MARIMOHUB_PG_PROD_URL` must
never silently start without it. Disable the integration to unblock the project
while you fix it.

Env-name precedence when sources collide: project secrets < integrations <
hub-injected vars (WIF, AI, system) — user-supplied values can never shadow the
hub's own.

A few PyIceberg settings (`legacy-current-snapshot-id`, `max-workers`) apply to
the whole process, not to one catalog, so two Iceberg integrations in the same
project must agree on them. They cannot be reconciled automatically — choosing
one value would change how the other integration reads data — so a disagreement
fails the session with an error naming both integrations and both values. Note
that the BigQuery catalog requires `legacy-current-snapshot-id`, so it cannot
share a project with a catalog that disables it. Align the values or disable one
of the two.

## Configuration

| Variable                       | Description                                                             |
| ------------------------------ | ----------------------------------------------------------------------- |
| `MARIMOHUB_INTEGRATIONS`       | `off` (default) or `on` — see the rollout note above.                   |
| `MARIMOHUB_INTEGRATIONS_PROBE` | "Test connection" egress policy: `guarded` (default), `private`, `off`. |
| `MARIMOHUB_SECRETS_KEK`        | Enables secret config fields (shared with managed secrets).             |

## Developing integration kinds

For source layout, kind contracts, schema evolution, and tests, see the
[integration developer guide](https://github.com/marimo-team/marimohub/blob/main/development_docs/integrations.md).
