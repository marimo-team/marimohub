# Service accounts

Service accounts authenticate deployment scripts without a browser login or human-owned PAT, including on an empty deployment.
`MARIMOHUB_SERVICE_ACCOUNTS` supplies their identities, permissions, and credential hashes. No bucket records are needed before the first request.

The sole permission, `org-integration.manage`, covers listing, reading, creating, updating, testing, and deleting **all org integrations**.
Integration tests can contact configured data services with their credentials.
Project access, notebook execution, general administration, PAT management, and MCP access are excluded.
For automation as a person, use a [PAT](./api-tokens.md) or [OIDC access token](./auth.md#external-access-tokens).

## Generate credentials

Install the [mohub CLI](./cli.md#install). Generate credentials in a private provisioning environment:

```sh
mohub service-account generate \
  --account ci-deploy --key initial --output-dir ./ci-credentials
```

The command works offline, without a profile, login, or running hub. It refuses existing output directories and prints no secrets.
It creates two files:

- `accounts.json`: complete service-account configuration containing credential hashes.
- `token`: client secret for `mohub --token-file` or `MARIMOHUB_TOKEN_FILE`.

On Unix, directory permissions are `0700` and file permissions are `0600`.
Store these files in your secret manager, outside source control and CI logs.
Credentials expire after 90 days by default. Use `--expires-in-days` for 1–3650 days or `mohub service-account generate --help` for all options.

On every server replica, supply the complete `accounts.json` contents:

```sh
export MARIMOHUB_SERVICE_ACCOUNTS="$(cat ./ci-credentials/accounts.json)"
```

Supply the token file only to the client:

```sh
export MARIMOHUB_TOKEN_FILE="$PWD/ci-credentials/token"
```

Keep the human authentication backend configuration. Restart all replicas after configuration changes.
The server receives only SHA-256 hashes of complete tokens, including their account and credential IDs.
Each random secret has 256 bits of entropy.

## Configuration rules

`MARIMOHUB_SERVICE_ACCOUNTS` accepts a JSON array of up to 32 accounts, limited to 64 KiB.
An unset variable or `[]` disables service accounts. Blank values, malformed JSON, invalid fields, and unknown fields prevent startup.

| Field                   | Type                | Requirement                                                                                        |
| ----------------------- | ------------------- | -------------------------------------------------------------------------------------------------- |
| Account `id`            | `string`            | Unique and stable. 1–64 lowercase letters, digits, or hyphens, starting with a letter.             |
| Account `name`          | `string` (optional) | 1–100 characters after trimming. Defaults to the account ID.                                       |
| Account `actions`       | `string[]`          | Only `["org-integration.manage"]`. Duplicate actions, wildcards, and project actions are rejected. |
| Account `credentials`   | `object[]`          | One to four credentials, allowing overlap during rotation.                                         |
| Credential `id`         | `string`            | Unique within the account, with the same format as account IDs. Use a new ID for each rotation.    |
| Credential `sha256`     | `string`            | Globally unique SHA-256 digest of the complete token. Exactly 64 lowercase hexadecimal characters. |
| Credential `expires_at` | `string` (optional) | UTC timestamp, such as `2027-01-01T00:00:00Z`. Omission disables automatic expiry.                 |

Expiry is checked on every request. At the expiry instant, credentials stop authenticating but do not prevent server startup.
The stable audit actor is `service-account:<id>`. Changing the account ID creates a new identity.
`IdentityService` owns directory display information and suspension state. The admin configuration summary redacts the entire account configuration.

## Provision integrations

Set `MARIMOHUB_URL` to your hub URL. Use the generated token file with the CLI:

```sh
mohub integrations org list
```

Provision through the existing [integration API](./api.md):

1. List all pages of org integrations and find the desired name.
2. If absent, create it with `POST /api/v1/org/integrations`.
3. If present, read its detail and ETag with `GET /api/v1/org/integrations/{id}`.
4. If changes are needed, PATCH with the returned `If-Match` value.
5. After a concurrent-create conflict or stale ETag response, reread the latest state before retrying.

Keep secret references in the desired configuration. Redacted API responses cannot establish secret equality through JSON comparison.
Skip unchanged integrations. The API preserves version history, audit events, name uniqueness, and conditional writes.

## Rotate or revoke

Pass the current deployment configuration to preserve existing accounts and keys:

```sh
mohub service-account generate \
  --account ci-deploy --key rotated --config ./ci-credentials/accounts.json \
  --output-dir ./rotated-credentials
```

The input file stays unchanged. Duplicate key IDs or a fifth credential fail before any output files are written.
The new configuration retains both credentials. The new token file contains only the replacement token.

For uninterrupted access:

1. Restart every replica with the new `accounts.json` before switching the client token.
2. Switch the client to the new `token` file.
3. Confirm that requests succeed.
4. Remove the old credential entry.
5. Restart every replica again.

To revoke a credential, remove its entry. If it is the last credential, remove the account instead.
Restart all replicas to complete revocation. Replicas with old configuration can accept old tokens until expiry or restart.
Account suspension also denies API access, with a cache delay of up to 30 seconds.
Removing an account preserves its audit history and identity record.

## Authentication behavior

Each bearer request selects one verifier:

| Credential         | Verifier                                                                        |
| ------------------ | ------------------------------------------------------------------------------- |
| `mhub_pat_…`       | Hub PAT service                                                                 |
| `mhub_sa_…`        | Configured service accounts                                                     |
| Other bearer token | Configured external OIDC access-token authenticator, or rejection when disabled |
| No bearer scheme   | Existing browser, proxy, or development authenticator                           |

Malformed or combined bearer headers return 401 before verification.
Invalid, expired, removed, or disabled bearer credentials cannot fall back to a browser cookie or proxy identity.
Bearer schemes are case-insensitive. Tokens are case-sensitive.
The reserved `service-account:` namespace prevents impersonation by SSO, PATs, or external OIDC tokens.

Service accounts are restricted to deployment resources, regardless of their grants.
Human memberships, default roles, and super-admin standing cannot expand those grants. Human authentication and PAT rules remain unchanged.
These are static credentials, without OAuth exchange or refresh tokens.
The Node configuration root supports `MARIMOHUB_SERVICE_ACCOUNTS`. The custom Cloudflare Worker entrypoint requires explicit library wiring.
