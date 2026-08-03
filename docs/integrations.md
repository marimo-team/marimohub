---
description: Configure project and organization data sources for notebook sessions, including databases, warehouses, query engines, catalogs, object storage, ML platforms, and environment variables.
---

# Integrations

A **project admin** can connect a data source once for one project. A
[super admin](./auth.md#super-admins-marimohub_super_admins) can connect a data
source for the whole organization. Supported sources include the common SQL
databases and warehouses (PostgreSQL, MySQL, SQL Server, MongoDB, ClickHouse,
Snowflake, BigQuery, Redshift, MotherDuck), query engines (Trino, Spark Connect,
Databricks SQL, Athena), PyIceberg catalogs, object storage (S3, GCS, Azure
Blob), ML platforms (Weights & Biases, Hugging Face), and environment
variables.

Each new, non-ephemeral session receives the applicable connection
configuration as environment variables and files. Notebook code never accesses
the hub API or storage. The hub injects configuration, not Python libraries.
Each kind lists the required packages below. Add those packages to the notebook
dependencies.

Set `MARIMOHUB_INTEGRATIONS=on` to enable integrations. If it is unset or
`off`, the routes return `404` and sessions receive no integration
configuration.

Before you enable integrations, deploy a compatible release to every replica.
Older replicas do not preserve the integration audit pins in session records.
See the two-phase policy in `development_docs/migrations.md`.

Integration configuration is versioned. Each save creates an immutable
revision. Each session records the revisions that it uses.

## Using an integration in a notebook

Each kind documents its sandbox contract — the env vars and files it renders —
in its section below and in the add-integration form. `<NAME>` is the
integration's instance name upper-cased with `-` → `_` (`prod` → `PROD`).

Every session also gets `MARIMOHUB_INTEGRATIONS_DIR` (default
`/tmp/marimohub-integrations`) containing each integration's rendered files and
a `manifest.json` naming the instances, kinds, and config versions in play. The
directory sits outside the workspace, so rendered config is never captured back
into the notebook's files.

Each kind declares the Python packages its contract assumes (**Notebook
packages** below, echoed into `manifest.json`). Add them to the notebook's
dependencies like any other package — the hub injects connection config, not
Python libraries.

In the configuration references below, fields are shown as dotted paths into
the config; `field: value` sub-tables list the extra fields available when a
selector takes that value.

### Connection variables and descriptors

Most kinds render one variable per connection field, named
`MARIMOHUB_<TOOL>_<NAME>_<FIELD>` (for example `MARIMOHUB_MYSQL_PROD_URL`),
alongside a descriptor at
`$MARIMOHUB_INTEGRATIONS_DIR/<tool>/<name>.json` that mirrors the same fields.
A secret is never written into the descriptor: it appears there as
`<field>_env`, naming the variable that holds it. Notebook code can therefore
read the shape of a connection from one file without that file carrying a
credential.

### Vendor-standard variables and one-click connections

Some kinds also set the variable names their ecosystem already expects, under
the `ambient_env` switch. There are two reasons to do that:

- **Object stores and ML platforms** are reached through libraries that read
  those variables and take no connection argument — `duckdb` and `polars` expect
  `AWS_ACCESS_KEY_ID`, `wandb` expects `WANDB_API_KEY`. These default **on**;
  Weights & Biases and Hugging Face have no other channel, so they always set
  them.
- **Databases and engines** already hand notebook code an explicit URL, so they
  default **off**. Turning `ambient_env` on publishes the names marimo's
  data-source discovery scans for, which makes the integration show up as a
  one-click connection in the notebook's data-source panel with no code to copy.

| Kind             | What marimo looks for                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| PostgreSQL       | `PGHOST`, `PGUSER`, `PGDATABASE` — also `PGPORT`, `PGPASSWORD`, `PGSSLMODE`, `PGSSLROOTCERT`      |
| MySQL            | `MYSQL_HOST`, `MYSQL_USER`, `MYSQL_DATABASE`, `MYSQL_PASSWORD` — also `MYSQL_TCP_PORT`            |
| Trino            | `TRINO_HOST`, `TRINO_USER`, `TRINO_CATALOG` — also `TRINO_PORT`, `TRINO_PASSWORD`, `TRINO_SCHEMA` |
| PySpark          | `SPARK_REMOTE`                                                                                    |
| S3               | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` — plus region and endpoint. On by default            |
| Iceberg catalogs | the rendered `.pyiceberg.yaml`, found through `PYICEBERG_HOME`. Always set                        |

Because these names are process-wide, only one integration per session can claim
a given variable. Two that set the same name to different values fail the session
with an error naming both — see the [failure model](#failure-model). That is also
why the database kinds default off: a project with a prod and a staging
PostgreSQL is ordinary, and only one of them can own `PGHOST`. When
[workload identity federation](./workload-identity-federation.md) is enabled it
injects `AWS_*` for the session's own bucket, and hub-injected variables win over
integrations.

Two combinations are refused at save time rather than rendered, because the
connection marimo would build is weaker than the one you configured:

- **MySQL with TLS on.** The discovered connection is a PyMySQL URL with no TLS
  arguments, and PyMySQL reads none from the environment, so it would be a
  plaintext path to a server this integration requires TLS for.
- **Trino with anything but Basic-over-HTTPS or no-auth-over-HTTP.** Discovery
  cannot express JWT, OAuth2, Kerberos, or certificate authentication, so the
  suggested connection could not authenticate.

PostgreSQL has no such caveat: libpq reads `PGSSLMODE` and `PGSSLROOTCERT` for
any parameter the caller leaves unset, so a discovered connection verifies
exactly like the rendered URL.

## PostgreSQL

The sandbox gets `MARIMOHUB_PG_<NAME>_URL` (a SQLAlchemy-ready
`postgresql://…` URL) plus `_HOST/_PORT/_DATABASE/_USER/_PASSWORD`, and a
secret-free descriptor at `$MARIMOHUB_INTEGRATIONS_DIR/postgres/<name>.json`.

```python
import os
import sqlalchemy

engine = sqlalchemy.create_engine(os.environ["MARIMOHUB_PG_PROD_URL"])
```

### TLS and certificates

New PostgreSQL integrations default to libpq's `verify-full`, which checks both
the certificate chain and the hostname. libpq does not consult the system trust
store on its own — with no `sslrootcert` it looks for `~/.postgresql/root.crt`
and fails when that file is absent — so the rendered URL points `sslrootcert` at
the sandbox image's CA bundle (`/etc/ssl/certs/ca-certificates.crt`). A publicly
trusted server therefore verifies with no extra setup. `require` encrypts but
authenticates nothing — choose it deliberately.

That default path is correct for the Debian-based images built here. Two ways to
point it elsewhere:

- **CA path** — an absolute path to a bundle the runtime already ships. Use it
  when a custom image keeps its bundle somewhere else (RHEL/UBI:
  `/etc/pki/tls/certs/ca-bundle.crt`), or under the host-based `local` compute
  backend, where the image's path does not exist.
- **CA bundle** — paste a private CA's PEM. It is written beside the
  integration's other files and `sslrootcert` points there.

Set one or the other, not both.

Turn on `ambient_env` to also export `PGHOST`, `PGUSER`, `PGDATABASE`,
`PGPORT`, `PGPASSWORD`, and the TLS pair, which is what makes this connection
[discoverable in the notebook](#vendor-standard-variables-and-one-click-connections).

<!--@include: ./partials/integrations/postgres.md-->

## MySQL

The sandbox gets `MARIMOHUB_MYSQL_<NAME>_URL` (a `mysql+pymysql://` URL) plus
`_HOST/_PORT/_DATABASE/_USER/_PASSWORD`, and a descriptor at
`$MARIMOHUB_INTEGRATIONS_DIR/mysql/<name>.json`. Works with MariaDB too.

New connections verify TLS: the rendered URL names a CA bundle, which makes
PyMySQL check both the chain and the hostname. Paste a private CA as
**CA bundle**, or point **CA path** at one the image already ships. The
intermediate MySQL modes are deliberately absent — they are spelled with
boolean-ish URL arguments whose meaning depends on how a driver version coerces
the string `"false"`, so the choice here is verified TLS or none.

`ambient_env` exports the `MYSQL_*` names for
[discovery](#vendor-standard-variables-and-one-click-connections), and is
available only on a connection with TLS disabled — see the caveat there.

<!--@include: ./partials/integrations/mysql.md-->

## Microsoft SQL Server

The sandbox gets `MARIMOHUB_MSSQL_<NAME>_URL` plus the usual connection
variables and a descriptor at
`$MARIMOHUB_INTEGRATIONS_DIR/sqlserver/<name>.json`.

Pick the driver your image has. **pyodbc** (default) encrypts and verifies by
default and needs the named ODBC driver installed in the sandbox image;
**pymssql** needs no system driver but leaves encryption to FreeTDS
negotiation, so it cannot enforce it.

<!--@include: ./partials/integrations/sqlserver.md-->

## MongoDB

The sandbox gets `MARIMOHUB_MONGODB_<NAME>_URL` for `pymongo.MongoClient`, plus
`_HOST/_DATABASE/_USER/_PASSWORD` and a descriptor at
`$MARIMOHUB_INTEGRATIONS_DIR/mongodb/<name>.json`.

`mongodb+srv` (the default) resolves the replica-set members from DNS, which is
how Atlas and most managed deployments are addressed; it ignores the port. A
literal seed list of several members is not supported — use SRV, or point at one
member with the `mongodb` scheme.

<!--@include: ./partials/integrations/mongodb.md-->

## ClickHouse

The sandbox gets `MARIMOHUB_CLICKHOUSE_<NAME>_HOST/_PORT/_SECURE/_DATABASE/_USER/_PASSWORD`
for `clickhouse_connect.get_client()`, a `clickhouse+http://` URL for
SQLAlchemy, and a descriptor at
`$MARIMOHUB_INTEGRATIONS_DIR/clickhouse/<name>.json`. **Test** probes the HTTP
interface with `SELECT version()`.

<!--@include: ./partials/integrations/clickhouse.md-->

## Snowflake

The sandbox gets `MARIMOHUB_SNOWFLAKE_<NAME>_ACCOUNT/_USER/_WAREHOUSE/_DATABASE/_SCHEMA/_ROLE`
plus the credential for the chosen method, and a descriptor at
`$MARIMOHUB_INTEGRATIONS_DIR/snowflake/<name>.json`.

Password authentication also renders `_URL` for `snowflake-sqlalchemy`. A key
pair cannot be expressed in a URL, so the PKCS#8 key is written beside the
integration and `_PRIVATE_KEY_PATH` points at it — pass it to
`snowflake.connector.connect()` instead of a URL.

<!--@include: ./partials/integrations/snowflake.md-->

## BigQuery

The sandbox gets `MARIMOHUB_BIGQUERY_<NAME>_URL` (a `bigquery://` URL for
`sqlalchemy-bigquery`) plus `_PROJECT_ID/_DATASET/_LOCATION`, and a descriptor
at `$MARIMOHUB_INTEGRATIONS_DIR/bigquery/<name>.json`.

A service-account key is written to a file and referenced by path — the URL
carries the path, never the key. `ambient_env` is off by default here, unlike
the storage kinds: the URL already names the key file, so leaving
`GOOGLE_APPLICATION_CREDENTIALS` to a [GCS integration](#google-cloud-storage),
whose client reads nothing else, keeps the two from colliding. Turn it on if you
want `bigquery.Client()` with no arguments to work and no GCS integration is
claiming it.

<!--@include: ./partials/integrations/bigquery.md-->

## Amazon Redshift

The sandbox gets `MARIMOHUB_REDSHIFT_<NAME>_URL` (a
`redshift+redshift_connector://` URL) plus the usual connection variables and a
descriptor at `$MARIMOHUB_INTEGRATIONS_DIR/redshift/<name>.json`.

Both offered SSL modes verify the chain against the driver's bundled Amazon
trust store; `verify-full` also checks the hostname. Disabling TLS is not
offered — the driver takes that as a real boolean, which a URL argument cannot
carry unambiguously.

<!--@include: ./partials/integrations/redshift.md-->

## MotherDuck

The sandbox gets `MARIMOHUB_MOTHERDUCK_<NAME>_URL`, an `md:` connection string
to hand to `duckdb.connect()`, plus `_TOKEN` and a descriptor at
`$MARIMOHUB_INTEGRATIONS_DIR/motherduck/<name>.json`.

```python
import duckdb
import os

con = duckdb.connect(os.environ["MARIMOHUB_MOTHERDUCK_PROD_URL"])
```

DuckDB's own `motherduck_token` variable is lower-case, which the hub cannot
emit (rendered names are POSIX-shell-safe upper-snake only), so the token rides
in the connection string instead.

<!--@include: ./partials/integrations/motherduck.md-->

## Iceberg catalogs

All Iceberg kinds are written into
`$MARIMOHUB_INTEGRATIONS_DIR/.pyiceberg.yaml`; `PYICEBERG_HOME` points there,
so `pyiceberg.catalog.load_catalog("<name>")` works directly:

```python
from pyiceberg.catalog import load_catalog

catalog = load_catalog("prod")
```

The typed storage selector (`storage.scheme`) covers catalog-provided
credentials, S3/compatible stores, GCS, ADLS, HDFS, and Hugging Face.
Process-wide worker/compatibility settings and PyArrow read behavior are also
typed. Non-secret PyIceberg options that are not first-class fields remain
available through `extra_properties`; credential-shaped keys are rejected there
so secrets cannot bypass encryption.

PyIceberg's in-memory catalog is intentionally not an integration kind: the
official documentation describes it as non-concurrent test/demo state, so it
cannot serve as a reusable project data source. Custom catalog implementations
and custom REST authentication managers are also excluded because accepting an
arbitrary Python class path would turn configuration into code loading. A few
PyIceberg settings apply to the whole process rather than one catalog; see the
[failure model](#failure-model) for how conflicting values are handled.

### Iceberg REST Catalog

Connects to an Iceberg REST catalog such as Polaris, Unity, Gravitino, or Glue.
Supports no auth, bearer tokens, Basic, OAuth2 client credentials, AWS SigV4,
Google ADC/service accounts, and Entra; REST/TLS tuning; access delegation; and
the documented remote FileIO families.

<!--@include: ./partials/integrations/iceberg_rest.md-->

### Iceberg SQL Catalog

Stores catalog metadata in PostgreSQL or SQLite, with SQLAlchemy
initialization, liveness, and logging options. The SQLAlchemy URI is encrypted
because it commonly embeds credentials.

<!--@include: ./partials/integrations/iceberg_sql.md-->

### Iceberg Hive Catalog

Connects PyIceberg to a Hive Metastore over Thrift, with Hive 2 compatibility,
Kerberos, and UGI options.

<!--@include: ./partials/integrations/iceberg_hive.md-->

### Iceberg AWS Glue Catalog

Uses AWS Glue as the metastore, with catalog/account/endpoint/retry
configuration and ambient, profile, encrypted static, or shared
catalog/FileIO AWS credentials.

<!--@include: ./partials/integrations/iceberg_glue.md-->

### Iceberg DynamoDB Catalog

Uses an AWS DynamoDB table as the catalog, with the same ambient, profile,
encrypted static, or shared catalog/FileIO AWS credential choices.

<!--@include: ./partials/integrations/iceberg_dynamodb.md-->

### Iceberg BigQuery Metastore

Uses Google BigQuery as the metastore, with ADC or encrypted service-account
JSON and independent FileIO configuration. BigQuery requires
`legacy-current-snapshot-id`, so it cannot share a project with a catalog that
disables it (see the [failure model](#failure-model)).

<!--@include: ./partials/integrations/iceberg_bigquery.md-->

## Trino

The sandbox gets `MARIMOHUB_TRINO_<NAME>_URL` plus connection env vars and a
descriptor at `$MARIMOHUB_INTEGRATIONS_DIR/trino/<name>.json`. Supports Basic,
JWT, OAuth2, client certificates, Kerberos, GSSAPI, TLS verification, headers,
extra credentials, roles, session properties, spooling, retries, timeouts,
isolation, and compatibility options.

`ambient_env` exports `TRINO_HOST`, `TRINO_USER`, `TRINO_CATALOG`, and the rest
for [discovery](#vendor-standard-variables-and-one-click-connections). It needs
a default catalog, and an authentication mode discovery can express.

<!--@include: ./partials/integrations/trino.md-->

## PySpark (Spark Connect)

The sandbox gets `MARIMOHUB_PYSPARK_<NAME>_REMOTE`, optional `_TOKEN`, and
`pyspark/<name>.json` with the SparkSession settings. Supports token auth, user
identity, gRPC keepalive/metadata, and plain or encrypted Spark configuration.

Pass the named remote URL to `SparkSession.builder.remote()`, then apply the
settings from the JSON descriptor before calling `getOrCreate()`. This
integration targets Spark Connect. Provisioning a classic Spark driver or
cluster remains the compute backend's responsibility.

`ambient_env` also exports the same string as `SPARK_REMOTE`, which
`SparkSession.builder` reads on its own and marimo
[discovers](#vendor-standard-variables-and-one-click-connections) — so
`getOrCreate()` needs no arguments at all.

<!--@include: ./partials/integrations/pyspark.md-->

## Databricks SQL

The sandbox gets `MARIMOHUB_DATABRICKS_<NAME>_HOST/_HTTP_PATH/_CATALOG/_SCHEMA`
for `databricks.sql.connect()`, plus the credential for the chosen method and a
descriptor at `$MARIMOHUB_INTEGRATIONS_DIR/databricks/<name>.json`. Personal
access tokens also render `_URL` for `databricks-sqlalchemy`; an OAuth service
principal cannot be expressed in a URL, so it renders `_CLIENT_ID` and
`_CLIENT_SECRET` instead. **Test** calls the workspace SCIM identity endpoint.

<!--@include: ./partials/integrations/databricks.md-->

## Amazon Athena

The sandbox gets `MARIMOHUB_ATHENA_<NAME>_URL` for PyAthena's SQLAlchemy
dialect, plus `_REGION/_DATABASE/_WORKGROUP/_CATALOG/_S3_STAGING_DIR` and a
descriptor at `$MARIMOHUB_INTEGRATIONS_DIR/athena/<name>.json`. Athena writes
query results to the staging prefix, so the credentials need write access to it.

With ambient credentials the URL keeps PyAthena's empty userinfo (`://:@`),
which is what makes the driver fall through to boto3's provider chain — an
instance profile, or an [S3 integration](#s3) that claims the ambient AWS
variables.

<!--@include: ./partials/integrations/athena.md-->

## Object storage

These kinds carry no query engine. They configure the credentials that `duckdb`,
`polars`, `pandas`, and the `fsspec` family use to read objects directly, and
they are how an Iceberg or Athena setup gets access to the data files behind its
metadata. See
[vendor-standard variables](#vendor-standard-variables-and-one-click-connections) for what `ambient_env`
claims and how collisions are reported.

### S3

The sandbox gets `MARIMOHUB_S3_<NAME>_BUCKET/_REGION/_ENDPOINT_URL/_ADDRESSING_STYLE`
plus static credentials when configured, and a descriptor at
`$MARIMOHUB_INTEGRATIONS_DIR/s3/<name>.json`. With `ambient_env` on it also sets
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_REGION`,
`AWS_DEFAULT_REGION`, and `AWS_ENDPOINT_URL_S3`.

The endpoint is S3-scoped on purpose: the unscoped `AWS_ENDPOINT_URL` would
point STS and every other AWS service at the same store. Path-style addressing
has no variable of its own — boto3 reads it from a config file — so choosing it
also renders one and sets `AWS_CONFIG_FILE`, which replaces any other profile
file the image ships.

Works with MinIO, Cloudflare R2, Ceph, and other S3-compatible stores: set the
endpoint and, for most of them, path-style addressing.

<!--@include: ./partials/integrations/s3.md-->

### Google Cloud Storage

The sandbox gets `MARIMOHUB_GCS_<NAME>_BUCKET/_PROJECT_ID/_CREDENTIALS_PATH` and
a descriptor at `$MARIMOHUB_INTEGRATIONS_DIR/gcs/<name>.json`. A service-account
key is written to a file; with `ambient_env` on, `GOOGLE_APPLICATION_CREDENTIALS`
and `GOOGLE_CLOUD_PROJECT` point at it, which is what `gcsfs` and
`google-cloud-storage` read.

<!--@include: ./partials/integrations/gcs.md-->

### Azure Blob Storage

The sandbox gets `MARIMOHUB_AZURE_<NAME>_ACCOUNT_NAME/_ACCOUNT_URL/_CONTAINER`
plus the credential for the chosen method, and a descriptor at
`$MARIMOHUB_INTEGRATIONS_DIR/azure/<name>.json`. With `ambient_env` on it sets
the `AZURE_STORAGE_*` names `adlfs` reads, and a service principal's
`AZURE_TENANT_ID`/`AZURE_CLIENT_ID`/`AZURE_CLIENT_SECRET` for
`DefaultAzureCredential`.

<!--@include: ./partials/integrations/azure_blob.md-->

## Weights & Biases

Sets `WANDB_API_KEY`, `WANDB_BASE_URL`, `WANDB_ENTITY`, `WANDB_PROJECT`, and
`WANDB_MODE`, so `wandb.init()` needs no `wandb.login()` and no key in the
notebook. `WANDB_DIR` points run files at `/tmp`, outside the workspace, so they
are not captured into a notebook version. **Test** authenticates against the
GraphQL API.

Because the client only reads these standard names, one project can have one
active Weights & Biases integration.

<!--@include: ./partials/integrations/wandb.md-->

## Hugging Face

Sets `HF_TOKEN` and `HF_ENDPOINT`, which authenticates `huggingface_hub`,
`transformers`, and `datasets` for gated models and private repositories.
`HF_HOME` points the model cache at `/tmp`, outside the workspace — model
weights are large and must not be captured into a notebook version. **Test**
calls `/api/whoami-v2`.

As with Weights & Biases, the client reads only these standard names, so one
project can have one active Hugging Face integration.

<!--@include: ./partials/integrations/huggingface.md-->

## Environment variables

Adds the exact environment variables that you configure. It supports plain
variables, scalar secret variables, and secret JSON bundles with optional prefixes.

<!--@include: ./partials/integrations/custom_env.md-->

## Managing integrations

Open a project and select **Environment & access**. Then select **Integrations**.
Members (`viewer`+) can see the list and protected configuration. An **`admin`** manages it, as does a
[super admin](./auth.md#super-admins-marimohub_super_admins), on every project.

- **Add** — pick a kind from the catalog; the form is generated from the kind's
  schema (conditional sections switch with the auth method). **Test** probes
  connectivity server-side for kinds that support it (Iceberg, Trino,
  ClickHouse, Databricks, Weights & Biases, Hugging Face) before you save. Because the probe is a server-side request to an admin-supplied address,
  it runs behind an egress policy: by default only public addresses are allowed
  (private, loopback, link-local/metadata ranges are rejected; redirects are
  never followed; responses are size- and time-capped; probes are rate-limited).
  Set `MARIMOHUB_INTEGRATIONS_PROBE=private` if your catalogs/engines live on a
  private network, or `off` to disable testing.
- **Edit** — a new immutable config version is appended; the version history is
  listed under `GET …/integrations/{iid}/versions`. Stored secret values show as
  an encrypted-value marker and are kept unless you replace them. External
  references show their backend and locator metadata. **Test connection** uses
  the current draft, including edited locators and unchanged encrypted values.
  The button appears only for kinds that support a connection test.
- **Enable / disable** — disabled integrations are skipped at session launch.
  This is also the escape hatch when a broken config is failing sessions.
- **Delete** — removes the instance and its entire version history.
- **Copy** — copy an integration from another project (**Add integration** →
  **Copy from another project**, or `POST …/integrations/copy`). You need
  the `admin` role on **both** projects; a super admin qualifies everywhere.
  The copy takes the source's current config and starts its own version history
  at v1. Inline values are decrypted and encrypted for the destination.
  External-reference metadata is preserved unchanged. The two copies are
  independent afterwards: editing or deleting one never affects the other. The
  audit trail records the copy with its source project and integration.

New sessions pick up config changes; running sessions keep what they launched
with (restart the session to apply).

### Updates and concurrency

The API treats an integration as one versioned resource. It does not expose
separate create, update, or delete operations for its secret fields. An update
submits the complete configuration and appends one immutable version.

Read the integration ETag before an automated update. Send that ETag as
`If-Match` with the write. If another client has updated the integration, the
server rejects the write. Managed markers keep unchanged inline values, while
external references include their complete backend and locator metadata.

Replacing an inline value does not overwrite its older ciphertext. The old
ciphertext remains in immutable versions until you delete the entire
integration. See [Integration secret sources](./integration-secrets.md) for the
retention and testing rules.

## Organization-wide integrations

A [super admin](./auth.md#super-admins-marimohub_super_admins) can configure an
integration once for the whole deployment. Use **Org integrations** in the user
menu, or use the `/api/v1/org/integrations` API routes.

Each organization integration applies to every project. It supplies
configuration to new, non-ephemeral sessions in those projects. The project
integration list shows inherited entries with an **org** badge. These entries
are read-only in the project. Users with viewer access can see their metadata,
but not their configuration.

To override an organization integration, create a project integration with the
same name. The project configuration then supplies new sessions in that
project. To opt out instead, create the same-name project integration and leave
it disabled. The list continues to show the inherited entry with an
**overridden** badge.

An organization integration that fails to render blocks new sessions in each
project that inherits it. See the [failure model](#failure-model). To unblock one
project, override the failing integration or opt out. To unblock all projects,
disable the organization integration.

Configuration changes apply to new sessions. Running sessions keep their
existing configuration.

## Secret fields

Each secret field can use an inline encrypted value or an external reference.
Inline values require `MARIMOHUB_SECRETS_KEK`. The API and storage formats call
inline encrypted values `managed`. API reads appear as
`{ "$secret": { "kind": "managed", "set": true } }`.

An external reference contains a configured backend and locator. The API shows
this metadata but never returns the resolved value. See
[Integration secret sources](./integration-secrets.md).

## Failure model

Integration rendering **fails a session closed**. A missing secret backend,
resolver error, invalid configuration, or decrypt error stops session creation.
The error does not disclose a secret value or locator. Disable the integration
to restore project access while you correct the configuration.

Saving an external reference does not fetch its value. **Test connection**
resolves the current draft only for supported kinds. **Environment variables**
has no pre-save connection test, so bundle and resolution errors can first
appear during session creation.

Environment-name precedence is integrations &lt; hub, WIF, AI, and marimo
configuration. An integration cannot replace a hub-controlled value.

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
| `MARIMOHUB_SECRETS_KEK`        | Enables inline encrypted integration secret fields.                     |

## Developing integration kinds

For source layout, kind contracts, schema evolution, and tests, see the
[integration developer guide](https://github.com/marimo-team/marimohub/blob/main/development_docs/integrations.md).
