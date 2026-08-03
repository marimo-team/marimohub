---
description: Configure inline encryption and external secret references for integration secret fields.
---

# Integration secret sources

An integration schema marks passwords, tokens, and private keys as secret
fields. Each secret field uses one configured source.

The integration catalog reports the available sources for every kind. The
editor shows only sources that the deployment configures.

If the editor shows no valid source, configure an inline encryption key or a
supported external resolver. The editor blocks the save until a source is
available.

| Source                    | The hub stores                         | Use it when                                         |
| ------------------------- | -------------------------------------- | --------------------------------------------------- |
| Inline encrypted value    | Ciphertext in each integration version | The hub must manage the value                       |
| External secret reference | A backend name and locator             | An external manager owns the value and its rotation |

## Inline encrypted values

An inline value is plaintext only during the save request. The hub encrypts it before it writes the integration version.

Configure a generated 32-byte key:

```bash
MARIMOHUB_SECRETS_KEK="$(openssl rand -base64 32)"
```

You can set `MARIMOHUB_SECRETS_KEK_ID` to label new envelopes. Keep the key outside the deployment bucket.

The API and storage formats call an inline encrypted value `managed`. The API returns this marker instead of its value:

```json
{ "$secret": { "kind": "managed", "set": true } }
```

The marker keeps an existing inline encrypted value during an edit. It cannot
keep an external reference. To retain or change a reference, submit its
complete backend and locator metadata. The API never returns the ciphertext
envelope through an integration response.

CAUTION: Keep a backup of the KEK. Existing inline values cannot be decrypted after the key is lost.

### Retention and deletion

Each save creates an immutable integration version. Replacing an inline value
creates a new ciphertext envelope. It does not overwrite the envelope in an
older version.

Old ciphertext remains in the integration history until you delete the entire
integration. The API does not provide per-field secret deletion.
This retention is a tradeoff of versioned integration storage.

## External secret references

An external reference stores a backend name and a locator. The hub does not store the resolved value in the integration version.

The authoring shape is:

```json
{
	"$secret": {
		"kind": "reference",
		"backend": "aws-sm",
		"locator": "prod/database#password"
	}
}
```

API reads return the same reference metadata. Reference metadata is not secret,
but resolved values never appear in API responses.

During a save, the hub checks the backend and the required reference fields. It
does not fetch the referenced value or validate it with the provider.

**Test connection** resolves references in the current draft when the
integration kind supports that test. **Environment variables** does not support
a connection test. Session creation resolves references for every enabled
integration.

A missing backend or resolver error stops the operation. Logs omit plaintext
values, locators, and provider error messages. At present, the API reports a
provider failure as HTTP 422. This includes outages and throttling events. The
API does not return HTTP 503 for these failures.

### AWS Secrets Manager

Set a region to enable the `aws-sm` backend:

```bash
MARIMOHUB_SECRETS_AWS_REGION=us-east-1
```

Alternatively, set `MARIMOHUB_SECRETS_AWS=true` when the AWS configuration supplies the region.

The resolver uses the default AWS credential chain. Static access-key variables are available for non-AWS deployments.

A locator uses `secret-id-or-arn[#json-key]`. The optional JSON key selects one
string field from a JSON secret. Omit the key when a JSON secret bundle must
resolve to the complete object.

The hub needs `secretsmanager:GetSecretValue`. It does not write to AWS Secrets Manager.

## Copy and inheritance

A project copy keeps external reference markers unchanged. It decrypts and
encrypts inline values for the destination integration.

Organization integrations use the same sources. A project inherits each
enabled organization integration unless it overrides that integration name.

## Environment variable bundles

The **Environment variables** integration supports three inputs:

- Plain variables store non-secret strings.
- Secret variables store one protected scalar per environment name.
- Secret JSON bundles expand a protected JSON object into multiple environment variables.

An optional prefix applies to every key in a JSON bundle. Environment names
must use uppercase letters, digits, and underscores.

The hub validates plain and scalar-secret names when you save. It validates a
bundle's JSON, generated names, and collisions only during session creation.
An invalid bundle can therefore be saved. New sessions then fail closed until
you correct it. Reserved hub variables are not allowed.

CAUTION: JSON bundle rows do not yet have stable identifiers. An unchanged
inline value is matched to a row by its array position. If you delete or reorder
rows, re-enter the inline value for every remaining bundle before you save.
This step prevents an old value from binding to the wrong prefix.

## Editing through the API

Secret fields belong to the complete integration configuration. To change one
field, read the integration, update its configuration, and submit the current
ETag with the write. Managed markers keep other inline values unchanged.

This model provides version history and concurrency checks. It does not provide
the separate create, update, and delete operations of a standalone secret
resource.

## Compatibility assumption

The standalone project-secret routes, bucket objects, and
`MARIMOHUB_SECRETS_BACKEND` setting were removed without a migration. This is
safe only for installations that did not use that unreleased subsystem.
