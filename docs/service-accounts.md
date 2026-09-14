# Service accounts

Service accounts authenticate deployment scripts without a browser login or a human-owned PAT.
The server reads their identities, permissions, and credential hashes from `MARIMOHUB_SERVICE_ACCOUNTS`.
An empty bucket needs no identity or token records before the first request.

The supported permission is `org-integration.manage`.
It permits listing, reading, creating, updating, testing, and deleting **all org integrations**.
It does not permit project access, notebook execution, general administration, PAT management, or MCP access.
Org integration tests can contact configured data services and use their credentials.

For automation that acts as a person, use a [personal access token](./api-tokens.md) or a configured [OIDC access token](./auth.md#external-access-tokens).

## Generate credentials

Run the following command with Node.js 24 or later in a private provisioning environment.
The output includes the client secret. Store that output in your secret manager, outside source control and CI logs.
Change `accountId` and `credentialId` before each new account or rotation.

```sh
node --input-type=module <<'JS'
import { createHash, randomBytes } from 'node:crypto';
const accountId = 'ci-deploy';
const credentialId = 'initial';
const token = `mhub_sa_${accountId}_${credentialId}_${randomBytes(32).toString('hex')}`;
const accounts = [{
  id: accountId,
  name: 'Deployment automation',
  actions: ['org-integration.manage'],
  credentials: [{
    id: credentialId,
    sha256: createHash('sha256').update(token).digest('hex'),
    expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
  }],
}];
console.log(JSON.stringify({
  MARIMOHUB_SERVICE_ACCOUNTS: JSON.stringify(accounts),
  MARIMOHUB_TOKEN: token,
}, null, 2));
JS
```

Supply the `MARIMOHUB_SERVICE_ACCOUNTS` value as a server environment variable on every replica.
Its value must be the JSON array, not the complete output object.
Supply `MARIMOHUB_TOKEN` only to the client script.
Keep the existing authentication backend configuration for human users.
Restart all replicas after a configuration change.

The server receives only SHA-256 hashes, not plaintext tokens.
The hash covers the complete token, including its account and credential IDs.
The random secret contains 256 bits of entropy.

## Configuration rules

`MARIMOHUB_SERVICE_ACCOUNTS` accepts a JSON array with at most 32 accounts and a total size of 64 KiB.
An unset variable or `[]` disables service accounts. A blank value, malformed JSON, or invalid field prevents startup.
Unknown fields also prevent startup, so a misspelled restriction cannot silently disappear.

| Field                   | Requirement                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Account `id`            | Unique and stable. Use 1–64 lowercase letters, digits, or hyphens, starting with a letter.                                |
| Account `name`          | Optional display name, with 1–100 characters after trimming. Defaults to the account ID.                                  |
| Account `actions`       | Required explicit array. Currently accepts only `["org-integration.manage"]`. Wildcards and project actions are rejected. |
| Account `credentials`   | One to four credentials. Multiple credentials permit overlap during rotation.                                             |
| Credential `id`         | Unique within the account, with the same format as account IDs. Use a new ID for each rotation.                           |
| Credential `sha256`     | Unique lowercase SHA-256 hex digest of the complete token: exactly 64 characters.                                         |
| Credential `expires_at` | Optional UTC timestamp, such as `2027-01-01T00:00:00Z`. Omission means no automatic expiry.                               |

Credential expiry applies on every request, including the exact expiry instant.
Expired credentials do not prevent server startup, but cannot authenticate.
Account IDs produce stable audit actors: `service-account:<id>`.
Changing an account ID creates a different identity.
The identity directory stores display information and suspension state through `IdentityService`.
The admin configuration summary redacts the complete account configuration.

## Provision integrations

Set `MARIMOHUB_URL` to your hub URL and `MARIMOHUB_TOKEN` to the client secret.

```sh
curl --fail-with-body "$MARIMOHUB_URL/api/v1/org/integrations" \
  -H "Authorization: Bearer $MARIMOHUB_TOKEN"
```

Use the existing [integration API](./api.md) for provisioning:

1. List all pages of org integrations and find the desired name.
2. If absent, create the integration through `POST /api/v1/org/integrations`.
3. If present, read its detail and ETag through `GET /api/v1/org/integrations/{id}`.
4. If a change is necessary, send a PATCH with the returned `If-Match` value.
5. After a concurrent-create conflict or a stale ETag response, read the latest state before another attempt.

Keep secret references in the desired configuration.
Secret values in API responses are redacted, so a direct JSON comparison cannot detect secret equality.
Avoid rewriting an integration when no change is necessary.
The API retains version history, audit events, name uniqueness, and conditional writes.

## Rotate or revoke

For rotation without interrupted access:

1. Generate a token with the same account ID and a new credential ID.
2. Add its credential entry alongside the old entry in the account configuration.
3. Restart every replica with both credentials before changing the client token.
4. Update the client secret and confirm that requests succeed.
5. Remove the old credential entry and restart every replica again.

For revocation, remove the credential entry. If it is the last credential, remove the account instead.
Restart all replicas to complete revocation. A replica with old configuration can still accept the old token until expiry or restart.
Suspending the account identity also denies API access, subject to the normal identity-suspension cache (up to 30 seconds).
Removing an account does not delete its audit history or identity record.

## Authentication behavior

Each bearer request selects exactly one verifier:

| Credential         | Verifier                                                                        |
| ------------------ | ------------------------------------------------------------------------------- |
| `mhub_pat_…`       | Hub PAT service                                                                 |
| `mhub_sa_…`        | Configured service accounts                                                     |
| Other bearer token | Configured external OIDC access-token authenticator, or rejection when disabled |
| No bearer scheme   | Existing browser, proxy, or development authenticator                           |

Malformed or combined bearer headers return 401 before verification.
An invalid, expired, removed, or disabled bearer credential cannot fall back to a browser cookie or proxy identity.
Bearer schemes are case-insensitive. Tokens are case-sensitive.
The `service-account:` identity namespace is reserved: SSO, PATs, and external OIDC tokens cannot impersonate these identities.

Service-account grants never inherit human memberships, default roles, or super-admin standing.
Existing human authentication and PAT grant rules still apply to human callers.
This feature supplies a static credential, without OAuth token exchange or refresh tokens.
The Node configuration root supports `MARIMOHUB_SERVICE_ACCOUNTS`; the custom Cloudflare Worker entrypoint needs explicit library wiring.
