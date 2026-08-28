---
description: Configure project and organization data sources for notebook sessions, including databases, warehouses, query engines, catalogs, object storage, ML platforms, and environment variables.
---

# Integrations

A **project manager** can connect a data source once for one project. A
[super admin](./auth.md#super-admins-marimohub_super_admins) can connect a data
source for the whole organization. Supported sources include the common SQL
databases and warehouses (PostgreSQL, MySQL, SQL Server, MongoDB, ClickHouse,
Snowflake, BigQuery, Redshift, MotherDuck, DuckLake), query engines (Trino, Spark Connect,
Databricks SQL, Athena), PyIceberg catalogs, object storage (S3, GCS, Azure
Blob), remote DuckDB databases, ML platforms (Weights & Biases, Hugging Face), and environment
variables.

Each new, non-ephemeral session receives the applicable connection
configuration as environment variables and files. Notebook code never accesses
the hub API or storage. The hub injects configuration, not Python libraries.
Each kind lists the required packages below. Add those packages to the notebook
dependencies.

Integrations are enabled by default. Set `MARIMOHUB_INTEGRATIONS=off` to make
the routes return `404` and prevent integration configuration from being
injected into sessions. Older releases also accepted `true` and `none`. Before
upgrading, replace those aliases with `on` and `off`; this release no longer
accepts them.

Integration configuration is versioned. Each save creates an immutable
revision. Each session records the revisions that it uses.

## Browse data

`MARIMOHUB_DATA_BROWSER=metadata` is the default: the Data page and browse API
are enabled for metadata. Set it to `full` to also enable row previews, object
previews, and object downloads, or to `off` to disable browsing. Browsing
requires integrations and an integration probe that is not `off`. The default
yields silently when integrations or the probe are off; an explicit `metadata`
or `full` setting fails at startup instead.

Editors and higher roles can use the Data page at `/projects/{pid}/data`.
They do not need a notebook session. The URL stores the selected integration,
surface, item, and search scope. A shared link restores the same view.

For catalog integrations, the Data page lists namespaces, tables, and schemas.
The schema view shows columns, partition fields, and available snapshot
statistics. S3 and GCS use buckets, prefixes, and objects. Azure Blob uses
containers, prefixes, and blobs.

Each detail view provides notebook code for the selected table or object.
**Open in notebook** creates and opens a notebook with this code. Before you run
the notebook, add the packages listed for that integration kind.

Browsing is read-only. Iceberg REST and ClickHouse use HTTP GET requests. Trino
submits hub-generated `SHOW`, `DESCRIBE`, and bounded `SELECT` statements. All
requests use the egress policy from `MARIMOHUB_INTEGRATIONS_PROBE`.

### Catalog browsing

The hub supports Iceberg REST Catalog, Trino, and ClickHouse. Trino uses the
catalog → schema → table hierarchy. ClickHouse uses database → table.

The hub cannot browse an Iceberg REST integration that uses:

- SigV4, Google, or Entra authentication
- a custom CA or client certificate

These configurations continue to work in notebook sandboxes.

Trino browsing supports no authentication, Basic authentication, and JWT with
system TLS. OAuth2, client certificates, Kerberos, GSSAPI, and custom TLS are
sandbox-only. ClickHouse requires certificate verification when using HTTPS.
Password authentication also requires HTTPS.

The `GET …/integrations/{iid}/browse` route reports the capabilities of one
integration and explains why a capability is unavailable.

### Object-store browsing

S3, GCS, and Azure Blob browsing supports these read-only operations:

- Navigate configured or accessible roots and prefixes.
- Search a bounded number of object names.
- Read metadata, tags, and version history.
- Load explicit previews and notebook snippets.
- Stream downloads through the hub.

The browser cannot upload, delete, restore, rename, or edit upstream objects or
metadata.

The API retains `bucket`, `key`, and `version_id` as provider-neutral compatibility fields. The UI
calls Azure roots containers. Copied and detail URIs use `s3://`, `gs://`, and `az://` respectively.

When an S3 integration sets `bucket`, the browser exposes only that bucket and does not call
`ListBuckets`. This is a user-interface scope, not an IAM restriction: notebook code still has every
permission granted to the integration credentials. Without `bucket`, the browser calls
`ListBuckets` and shows the accessible result.

Metadata mode prevents the hub from returning object bodies. Full mode permits
explicit previews and downloads. S3 authorizes `HeadObject` with the same read
actions as content. Thus, IAM cannot grant separate metadata-only HEAD access.
Grant only the actions required by the selected features:

- `s3:ListAllMyBuckets` when the integration has no configured bucket.
- `s3:ListBucket` for prefixes and bounded key-name search.
- `s3:GetObject` for current-object metadata, previews, and downloads.
- `s3:GetObjectVersion` for selected-version metadata, previews, and downloads.
- `s3:ListBucketVersions` for version history.
- `s3:GetObjectTagging` to show tags. A denied tag request does not hide other
  metadata.

Substring search is a bounded recursive S3 listing, not a persistent index or content search. The
Data page reports how many keys were scanned and whether more keys may exist. Continue the search
to scan the next bounded segment. Prefix navigation uses S3's native `Prefix` operation and is less
expensive.

Selecting an object performs metadata reads only. Content is fetched after **Load preview** or
**Download**. CSV, TSV, JSON, JSON Lines, Parquet, UTF-8 text/code/Markdown/logs, and magic-byte-
validated PNG, JPEG, GIF, and WebP files can be previewed within configured byte, row, column,
request, result, and deadline limits. HTML, SVG, PDF, archives, executables, unknown binary files,
and oversized images are never rendered inline. Truncated previews say so.

Downloads remain behind hub authorization and stream through the server. They
support one HTTP byte range and preserve ETag or version preconditions. They
also use safe attachment filenames and propagate client cancellation upstream.
The hub does not return provider credentials or presigned URLs.

The raw content endpoint is
`GET /api/v1/projects/{pid}/integrations/{iid}/browse/objects/content`. It requires `bucket` and
`key`; `version_id`, `etag`, and `inline=true` are optional. Editors and higher roles can send one
`Range: bytes=…` header and receive `200` or `206`. Pre-stream failures use the standard JSON error
envelope, including `403`, `404`, `412`, `416`, `429`, and `503` responses.

Static integration credentials are used only for that integration. S3 ambient-auth integrations use
short-lived project WIF credentials when the project enables a compatible target. The WIF storage
endpoint and integration endpoint must be the same canonical origin. Otherwise, ambient object
browsing for S3 remains unavailable unless the operator explicitly sets
`MARIMOHUB_OBJECT_BROWSER_ALLOW_SERVER_AMBIENT_CREDENTIALS=true`. That setting grants project
editors access through the control-plane AWS identity. Enable it only when that
access is intentional.

GCS service-account integrations use `storage.buckets.list` for discovery.
They use `storage.objects.list` for navigation and versions. They use
`storage.objects.get` for metadata and content. Ambient GCS uses ADC only when
the server-ambient option is enabled. Bucket discovery requires a project ID
from the integration, service-account key, ADC environment, or metadata
service. GCS generations map to `version_id`. Version history uses the native
`versions=true` listing and has no delete-marker records.

Azure supports account keys, SAS tokens, connection strings, service principals, and
`DefaultAzureCredential`. Grant container listing only when discovery is needed, blob listing for
navigation and versions, and blob read/tag permissions for metadata and content. Azure blob version
IDs map to `version_id`; accounts without Blob Versions return an empty terminal history while
current blobs remain browsable. Soft-deleted blobs are not labeled as S3 delete markers.

Server-ambient browsing gives project editors the hub control-plane identity for
each ambient provider. GCS accepts standard ADC service-account,
authorized-user, external-account, and metadata credentials. GCS external
accounts and Azure Entra tokens can expose every object that these identities
can read. Keep this option off unless that access is intentional. Provider data
traffic uses the guarded resolver. Provider SDKs manage ambient authentication.
Azure Entra traffic is limited to fixed authority hosts. All browser operations
are read-only.

Custom endpoints use the configured guarded/private integration egress policy. `guarded` rejects
private, loopback, link-local, metadata, and other reserved targets. Use `private` only when an
on-premises S3-compatible endpoint must be reachable. Every final SDK hostname, including generated
virtual-host names and retries, is resolved, checked, and pinned before transport.

Successful object previews and opened downloads create `integration.object.preview` and
`integration.object.download` audit events. Routine listing, search, and metadata navigation do not.
Object content, credentials, signed headers, and provider error text are not stored in browse
caches or audit events.

S3-compatible implementations can omit bucket discovery, tags, checksums, or
versioning. If `ListBuckets` is unavailable, configure a bucket. The Data page
shows optional features that the target or credentials do not support. For a
private endpoint timeout, make sure that the probe is set to `private`. Then
make sure that server DNS and TLS trust are correct. See the object-browser
limits in [Configuration](./configuration.md).

### Row previews

The Preview tab does not load data automatically. Select **Load preview** to
request rows. The response is not cached, and a successful request creates an
audit event.

Trino and ClickHouse run bounded preview queries through their HTTP APIs. Other
browsable integrations emit a runtime-specific preview program. The preview
service prefers DuckDB-Wasm SQL when the runtime supports every required
feature, then falls back to a new sandbox running a fixed Python program.

The DuckDB executor is enabled by default in full data-browser mode.

The Node server uses a worker thread. Blocking inline execution is unavailable
because a query cannot be preempted at its deadline. Each query runs in a
read-only transaction after the runtime sets its memory limit and locks configuration.
The unbrokered runtime disables external access and rejects remote Node file callbacks.

The brokered runtime supports explicit S3 storage. It requires all these values:

- no authentication, bearer-token authentication, or OAuth2 client credentials
- no access delegation
- explicit S3 storage with an origin-only endpoint, using path-style or virtual-hosted addressing
- static S3 credentials or anonymous access
- one or more guarded S3 read locations
- system TLS and default runtime options

Switch **Storage** from the default `catalog` scheme to `s3` before you configure the brokered
profile. The `storage.broker_read_locations` field only appears on that `s3` branch; set it to
the bucket prefixes that DuckDB can read. Set **Access delegation** to `none`.
The worker receives no real catalog or S3 credentials.
The parent broker authorizes each request, injects credentials, checks DNS results, and pins the target socket.
Authenticated catalog, OAuth2, and S3 endpoints require HTTPS by default. Enable
`allow_insecure_transport` only for local development.

> **Upgrade note:** Stored authenticated HTTP S3 configurations keep their current behavior.
> The schema migration enables `allow_insecure_transport` for those configurations.
> New configurations must enable this option explicitly.

For OAuth2, the parent owns the client secret and refreshes the access token. The token endpoint
uses the configured integration egress policy. Access tokens stay in one broker session. The worker
receives only the dummy token from the generated `ATTACH` statement.

The broker also supports S3 credentials from a trusted Iceberg REST catalog. Configure this path as
follows:

```yaml
storage:
  scheme: catalog
  vended_s3:
    endpoint: https://s3.us-east-1.amazonaws.com
    region: us-east-1
    force_virtual_addressing: true
    allowed_locations:
      - bucket: warehouse
        prefix: production/
access_delegation: vended_credentials
```

Each allowed location is a maximum bound. The catalog cannot grant a sibling prefix, bucket, or
endpoint. An empty prefix grants its complete bucket.

The catalog must use HTTPS. The storage endpoint must be an HTTPS origin. The broker supports
path-style and virtual-hosted S3 requests.

The broker reads prefixes from `LoadTable` and table-credentials responses. It installs each route
before DuckDB reads an object. The parent does not store the credential values.

Only SigV4 authorization, date, payload-hash, and session-token headers enter dynamic storage
routes. These headers cannot enter catalog routes or unmatched storage routes.

GCS, Azure storage, remote signing, server-side scan responses, and worker-selected endpoints are
not supported. These configurations use the Python executor.

Bounded vended routes are available when guarded DuckDB HTTP is enabled. R2 Data Catalog routes use
a bound from the catalog URI instead of configured `allowed_locations`.

Other Iceberg configurations continue to use the sandbox executor.

Sandbox previews require `MARIMOHUB_DATA_PREVIEW_IMAGE`. The image must contain
Python, PyIceberg, and PyArrow. The compute backend must support per-sandbox
OCI image overrides. The `local`, `e2b`, `none`, and `noop` backends do not
support them.

At startup, the hub verifies each configured executor before advertising it.
Each preview receives the selected integration configuration and applicable WIF
credentials. Concurrency limits and deadlines bound resource use. The hub
destroys the sandbox after the request, including after a failure.

### Run SQL

The `POST …/integrations/{iid}/browse/query` operation is always present in the
API contract. It returns `404` unless integrations are enabled and full data
browsing is selected:

```bash
MARIMOHUB_DATA_BROWSER=full
```

OAuth2 Iceberg catalogs and S3 object queries are enabled with full data browsing. To take a
capability away from one integration, disable that integration.

Only project managers and administrators can run SQL. Each request receives a
fresh DuckDB-Wasm worker, runs one statement in a read-only transaction, and is
hard-terminated at its deadline. Direct remote callbacks, automatic extension
installation, automatic extension loading, and configuration changes are disabled.
Brokered Iceberg and S3 plans can load only pinned local extensions and approved URLs.
Row, response-byte, concurrency, per-user, memory, and time limits apply.
Successful queries create an audit event that records sizes and row counts, never SQL text.

### Remote DuckDB database files

The `duckdb_http` integration attaches one database file as a read-only DuckDB catalog for Run SQL.
It does not expose schema browsing or inject configuration into notebook sessions. Enable full
data browsing to use Run SQL:

```bash
MARIMOHUB_DATA_BROWSER=full
```

Configure an exact object URL:

```yaml
url: https://data.example.com/snapshots/2026-08-27/analytics.duckdb
auth:
  method: bearer_token
  token: secret
```

The URL must use HTTPS. It cannot contain embedded credentials, query parameters, a fragment,
encoded path separators or dot segments, or a trailing slash. Its normalized path must end in
`.duckdb` unless the advanced suffix override is enabled. Authentication can be `none`,
`bearer_token`, or `basic`.
Bearer tokens and Basic passwords stay in the parent process. The DuckDB worker cannot read them.

The broker authorizes only the normalized URL, not its origin, parent path, or sibling files. GET
and HEAD are the only methods. Redirects are rejected because the target would be outside the exact
object capability. The server must support single byte ranges, return valid `Content-Range` values
for 206 responses, and return one strong ETag on every successful response. Weak or missing ETags,
multipart ranges, inconsistent lengths, changed ETags, and `412 Precondition Failed` responses stop
the query. After the first response, the broker sends `If-Match` on every later request.

One query can make at most 512 remote requests, with 4 in flight, and receive at most 64 MiB in
total. One response is limited to 16 MiB. A server that ignores a GET range is accepted only when
the complete object is at most 1 MiB. The database does not need to fit in memory, but a query that
reads more than the cumulative budget fails. Keep remote databases at or below 1 GiB and test
representative scans against the 64 MiB read budget.

Publish new snapshots at new versioned paths and retain old snapshots while queries can still be
running. Replacing bytes at the same URL is safe between queries, but replacement during a query
fails the ETag precondition. A static Nginx location can preserve old files and provide ranges and
strong ETags:

```nginx
location /snapshots/ {
    alias /srv/duckdb-snapshots/;
    etag on;
    max_ranges 1;
    add_header Cache-Control "public, max-age=31536000, immutable";
}
```

Write each snapshot to a new directory before publishing its URL. Do not overwrite or delete a
snapshot until the longest possible Run SQL request has ended.

<!--@include: ./partials/integrations/duckdb_http.md-->

### DuckLake

The `ducklake` integration reads one DuckDB metadata catalog and its S3 data files.
The integration is available only for Run SQL. It does not add files or variables to notebook sessions.

The pinned DuckDB 1.4.3 extension supports DuckLake specification version `0.3`.
It does not support automatic migration. Create the metadata catalog with DuckDB 1.4.3.

Configure an immutable metadata URL and explicit S3 bounds:

```yaml
metadata:
  type: duckdb
  url: https://data.example.com/catalog/releases/42.ducklake
  auth:
    method: bearer_token
    token: secret
storage:
  scheme: s3
  endpoint: https://s3.us-east-1.amazonaws.com
  region: us-east-1
  force_virtual_addressing: true
  credentials:
    method: static
    access_key_id: secret
    secret_access_key: secret
  broker_read_locations:
    - bucket: warehouse
      prefix: ducklake/data/
snapshot:
  version: 42
```

The metadata URL uses the same exact-object policy as `duckdb_http`.
The server must return single byte ranges and one strong ETag.
The broker rejects redirects, changed objects, and sibling paths.

The S3 endpoint must be an HTTPS origin. Each read location grants one bucket prefix.
The broker rejects requests outside these locations, even if the metadata catalog contains another path.

The worker receives dummy S3 credentials. The parent broker adds the real S3 signature to approved requests.
Metadata authorization cannot enter an S3 request. S3 authorization cannot enter a metadata request.

DuckLake attaches the catalog with `READ_ONLY` and `CREATE_IF_NOT_EXISTS false`.
The integration does not set `DATA_PATH` or `OVERRIDE_DATA_PATH`.
The extension reads the data path from the metadata catalog.

Set `snapshot.version` or `snapshot.timestamp` to read a historical snapshot.
Do not set both fields. Omit both fields to read the latest snapshot.

SQLite metadata and standalone SQLite files are not supported.
The pinned SQLite extension cannot open a DuckDB-Wasm buffer registration.
This restriction prevents host-path access and accidental database creation.

<!--@include: ./partials/integrations/ducklake.md-->

### DuckDB remote-read errors

Remote-read errors include a stable code and a safe explanation. They do not include credentials,
object paths, endpoint URLs, or OAuth2 response bodies. This table lists every code returned to Run
SQL callers.

| Code                            | Action                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------- |
| `capability_expired`            | Retry with a smaller query.                                                      |
| `capability_unknown`            | Retry the query. Reopen the integration if the error continues.                  |
| `credential_failed`             | Make sure that authenticated endpoints use HTTPS and credentials are valid.      |
| `dynamic_route_budget_exceeded` | Narrow the query, or configure fewer vended storage prefixes.                    |
| `header_denied`                 | Remove the unsupported header, or use the sandbox runtime.                       |
| `invalid_capability`            | Edit and re-save the integration. Contact an administrator if the error repeats. |
| `invalid_request`               | Make sure that the remote URL and headers are valid.                             |
| `method_denied`                 | Use a GET or HEAD read, or use the sandbox runtime.                              |
| `object_changed`                | Retry against an immutable versioned DuckDB URL.                                 |
| `range_invalid`                 | Configure the database server to return valid single byte ranges.                |
| `redirect_denied`               | Configure the DuckDB integration with the final exact object URL.                |
| `redirect_budget_exceeded`      | Make sure that the integration endpoint is correct.                              |
| `request_budget_exceeded`       | Narrow the query, or split it into smaller queries.                              |
| `response_budget_exceeded`      | Select fewer columns or rows.                                                    |
| `strong_etag_required`          | Configure the database server to return a strong ETag.                           |
| `target_denied`                 | Make sure that catalog redirects and `broker_read_locations` are correct.        |
| `transport_failed`              | Make sure that DNS, TLS, and the integration egress policy permit the endpoint.  |

### Scope and caching

The browse API resolves an ID in the project tier before the organization tier.
An organization integration is available from each project that inherits it.
A project integration with the same name shadows the organization integration.

Each request checks whether the integration is available before it reads the
cache. Disabling or shadowing an integration therefore takes effect immediately.
A new configuration version uses a new cache entry.

Each replica can cache namespace and table lists for one minute and object-store root/object lists for 15 seconds.
It can cache table schemas for five minutes. Searches, previews, tags, versions, content, failures,
and authorization denials are not cached. Browse requests have per-user rate limits. The
**Refresh** action bypasses the response cache, but it still uses the rate
limit.

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
- **Databases and engines** also hand notebook code an explicit URL or
  descriptor, but their discovery variables default **on**. This makes a
  compatible integration show up as a one-click connection in marimo's
  data-source panel with no code to copy.

| Kind             | What marimo looks for                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| PostgreSQL       | `PGHOST`, `PGUSER`, `PGDATABASE` — also `PGPORT`, `PGPASSWORD`, `PGSSLMODE`, `PGSSLROOTCERT`      |
| MySQL            | `MYSQL_HOST`, `MYSQL_USER`, `MYSQL_DATABASE`, `MYSQL_PASSWORD` — also `MYSQL_TCP_PORT`            |
| Trino            | `TRINO_HOST`, `TRINO_USER`, `TRINO_CATALOG` — also `TRINO_PORT`, `TRINO_PASSWORD`, `TRINO_SCHEMA` |
| PySpark          | `SPARK_REMOTE`                                                                                    |
| S3               | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` — plus region and endpoint. On by default            |
| Iceberg catalogs | the rendered `.pyiceberg.yaml`, found through `PYICEBERG_HOME`. Always set                        |

Because these names are process-wide, only one integration per session can claim
a discovery contract. When multiple integrations request the same names, the
first by integration name is discovered. The others remain available through
their namespaced variables and notebook snippets. The session manifest and
provisioning log contain a warning naming the selected and skipped integrations.
When
[workload identity federation](./workload-identity-federation.md) is enabled it
injects `AWS_*` for the session's own bucket, and hub-injected variables win over
integrations.

Two combinations fall back to the namespaced connection instead of advertising a
connection that is weaker than the one you configured:

- **MySQL with TLS on.** The discovered connection is a PyMySQL URL with no TLS
  arguments, and PyMySQL reads none from the environment, so it would be a
  plaintext path to a server this integration requires TLS for.
- **Trino with anything but Basic-over-HTTPS or no-auth-over-HTTP.** Discovery
  cannot express JWT, OAuth2, Kerberos, or certificate authentication, so the
  suggested connection could not authenticate.

These fallbacks do not block session creation and emit a provisioning warning.
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

### Hub data browser

Direct PostgreSQL browsing is off by default. Enable it for all compatible PostgreSQL integrations:

```bash
MARIMOHUB_POSTGRES_DATA_ACCESS=on
```

The default `metadata` mode lists user schemas, selectable relations, and columns. Full mode also
enables row previews and PostgreSQL-native Run SQL:

```bash
MARIMOHUB_DATA_BROWSER=full
```

The Node server starts one worker and one database connection for each operation. It resolves the
configured host through `MARIMOHUB_INTEGRATIONS_PROBE`, pins the approved addresses, and keeps the
configured host for TLS SNI and hostname verification. `guarded` permits public targets. `private`
also permits trusted private and loopback services. Cloudflare Workers do not install this runtime.

The hub supports `verify-ca` and `verify-full` when only the data-access switch is on. The
`disable`, `prefer`, and `require` modes need this separate deployment override:

```bash
MARIMOHUB_POSTGRES_ALLOW_INSECURE_TRANSPORT=on
```

For hub access, paste a private CA into **CA bundle**. A custom **CA path** remains available to the
notebook sandbox, but the hub cannot read sandbox image paths. Without a pasted bundle, the hub
uses Node's default trust roots. This works across supported Node platforms and does not depend on
a Linux distribution's CA path.

Run SQL uses PostgreSQL syntax. It runs one row-producing statement inside a read-only transaction
with statement, lock, idle-transaction, row, byte, and wall-clock limits. Cancellation sends a
PostgreSQL cancel request through a separately pinned socket. For TLS sessions, the cancel socket
uses the same encryption, CA, and hostname-verification policy before it sends the backend cancel
key, as supported by the
[PostgreSQL protocol](https://www.postgresql.org/docs/current/protocol-flow.html#PROTOCOL-FLOW-CANCELING-REQUESTS).
The cancel request is plaintext only for `disable` or when `prefer` falls back to plaintext.

PostgreSQL read-only transactions do not prevent every effect from a volatile user-defined
function. Create a dedicated role with only the required `CONNECT`, schema `USAGE`, and table or
view `SELECT` privileges. Do not grant write privileges or broad function execution rights to the
production browser role.

For an emergency rollback, set `MARIMOHUB_POSTGRES_DATA_ACCESS=off`. Then restart the server.
This change does not disable other data browsers. Existing notebook PostgreSQL connections remain
available.

The runtime emits `postgres_runtime.operation` counters and `postgres_runtime.duration_ms`
histograms. Labels contain only the operation and fixed outcome. Target policy, authentication,
TLS, connection, timeout, malformed-result, and worker failures use fixed messages. A rejected SQL
statement can also return its five-character SQLSTATE and a character position adjusted to the
submitted statement. It never returns PostgreSQL's provider message. Check the data-browser mode,
egress policy, role grants, TLS mode, and CA bundle for failures. The runtime does not log SQL,
hostnames, database names, relation names, credentials, or provider error bodies.

By default, `ambient_env` also exports `PGHOST`, `PGUSER`, `PGDATABASE`,
`PGPORT`, `PGPASSWORD`, and the TLS pair, which makes this connection
[discoverable in the notebook](#vendor-standard-variables-and-one-click-connections).
Turn it off to expose only the namespaced connection.

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

`ambient_env` requests the `MYSQL_*` names for
[discovery](#vendor-standard-variables-and-one-click-connections). They are
emitted only when TLS is disabled; otherwise the namespaced TLS connection stays
available and the provisioning log explains the fallback.

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

By default, `ambient_env` exports `TRINO_HOST`, `TRINO_USER`, `TRINO_CATALOG`,
and the rest for
[discovery](#vendor-standard-variables-and-one-click-connections). It needs a
default catalog, system TLS verification, and an authentication mode discovery
can express. Other configurations keep the namespaced connection and emit a
provisioning warning.

<!--@include: ./partials/integrations/trino.md-->

## PySpark (Spark Connect)

The sandbox gets `MARIMOHUB_PYSPARK_<NAME>_REMOTE`, optional `_TOKEN`, and
`pyspark/<name>.json` with the SparkSession settings. Supports token auth, user
identity, gRPC keepalive/metadata, and plain or encrypted Spark configuration.

Pass the named remote URL to `SparkSession.builder.remote()`, then apply the
settings from the JSON descriptor before calling `getOrCreate()`. This
integration targets Spark Connect. Provisioning a classic Spark driver or
cluster remains the compute backend's responsibility.

By default, `ambient_env` also exports the same string as `SPARK_REMOTE`, which
`SparkSession.builder` reads on its own and marimo
[discovers](#vendor-standard-variables-and-one-click-connections) — so
`getOrCreate()` needs no arguments at all.

**Test** verifies DNS, TCP reachability, and the TLS handshake when enabled. It
does not create a Spark session or validate authentication and Spark configuration.

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

Run SQL requires an explicit endpoint, static credentials or anonymous access, and a guarded read
location. Each location grants one bucket prefix. The default bucket does not grant access.
Static credentials require HTTPS by default. Enable `allow_insecure_transport` only for local
development. Anonymous endpoints can use HTTP without this option.

> **Upgrade note:** Stored authenticated HTTP S3 configurations keep their current behavior.
> The schema migration enables `allow_insecure_transport` for those configurations.
> New configurations must enable this option explicitly.

Use exact Parquet or CSV object paths. Globs are unavailable because they require a broader S3 list
request. JSON is unavailable until the DuckDB-Wasm package includes the signed `json` extension.
The broker permits only `GET` and `HEAD`, so queries cannot write objects.

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
variables, secret variables, and secret JSON bundles with optional prefixes.

<!--@include: ./partials/integrations/custom_env.md-->

## Managing integrations

Open a project and select **Environment & cloud access**. Then select **Integrations**.
Members can view the list and protected configuration. Project managers and
[super admins](./auth.md#super-admins-marimohub_super_admins) can make changes.

- **Add** selects a kind and opens its schema-based form.
- **Test connection** runs against the current draft for supported kinds. It
  includes edited references and unchanged inline values.
- **Edit** appends an immutable configuration version. List versions at
  `GET …/integrations/{iid}/versions`.
- **Enable or disable** controls whether new sessions receive the integration.
  Disable a broken integration to restore session access.
- **Delete** removes the integration and its complete version history.
- **Copy from another project** copies the current version and starts at v1.
  You need manager access to both projects. Inline values get new encryption for
  the destination. External references remain unchanged.

Connection tests run from the server. The default egress policy permits only
public targets. It blocks redirects and private, loopback, link-local, metadata,
and CGNAT addresses. It also limits response size, duration, and request rate.

Set `MARIMOHUB_INTEGRATIONS_PROBE=private` for private targets. Set it to `off`
to disable connection tests.

New sessions use configuration changes. Restart a running session to apply them.

### Updates and concurrency

The API updates an integration as one resource. Each update submits the complete
configuration and appends an immutable version.

For automation, read the integration ETag and send it as `If-Match`. If another
client changed the integration, the server rejects the update.

Managed markers keep unchanged inline values. References include their complete
backend and locator. See [Integration secret sources](./integration-secrets.md)
for retention and testing rules.

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

Each secret field uses an inline encrypted value or an external reference.
API reads return a marker for inline values or metadata for references. They
never return a resolved value. See
[Integration secret sources](./integration-secrets.md) for setup and API shapes.

## Failure model

Integration rendering fails closed. A secret-source or configuration error
stops session creation without disclosing secret values or locators.

Automatic data-source discovery is best effort. An incompatible discovery
contract or a second integration claiming the same standard variables falls
back to namespaced variables and a notebook snippet instead of failing the
session. The session manifest and provisioning log record the fallback.

Saving a reference does not fetch its value. **Test connection** resolves the
current draft for supported kinds. **Environment variables** has no connection
test, so its resolution errors can first appear during session creation.

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

| Variable                       | Description                                                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `MARIMOHUB_INTEGRATIONS`       | `on` (default) or `off` to disable routes and session injection. Replace the removed `true`/`none` aliases before upgrading. |
| `MARIMOHUB_INTEGRATIONS_PROBE` | "Test connection" egress policy: `guarded` (default), `private`, `off`.                                                      |
| `MARIMOHUB_SECRETS_KEK`        | Enables inline encrypted integration secret fields.                                                                          |

## Developing integration kinds

For source layout, kind contracts, schema evolution, and tests, see the
[integration developer guide](https://github.com/marimo-team/marimohub/blob/main/development_docs/integrations.md).
