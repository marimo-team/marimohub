---
description: Configure inline encryption and external secret references for integration secret fields.
---

# Integration secret sources

Integration schemas mark passwords, tokens, and private keys as secret fields.
Each populated secret field uses one configured source.

The editor shows the sources that are available for the selected integration.
If no source is available, configure inline encryption or an external resolver.

| Source                    | The hub stores                         | Use it when                                    |
| ------------------------- | -------------------------------------- | ---------------------------------------------- |
| Inline encrypted value    | Ciphertext in each integration version | The hub manages the value                      |
| External secret reference | A backend name and locator             | An external manager owns and rotates the value |

## Inline encrypted values

An inline value is plaintext only during the save request. The hub encrypts it
before it writes the integration version.

Configure a generated 32-byte key:

```bash
MARIMOHUB_SECRETS_KEK="$(openssl rand -base64 32)"
```

You can set `MARIMOHUB_SECRETS_KEK_ID` to label new envelopes. Keep the KEK
outside the deployment bucket.

The API and storage formats call an inline encrypted value `managed`. API reads
return this marker instead of the value:

```json
{ "$secret": { "kind": "managed", "set": true } }
```

The marker keeps an existing value during an edit. The integration API returns
neither its plaintext nor its ciphertext.

CAUTION: Keep a backup of the KEK. If you lose it, the hub cannot decrypt existing inline values.

### Retention and deletion

Each save creates an immutable integration version. Replacing an inline value
adds new ciphertext and leaves the old version unchanged.

Old ciphertext remains until you delete the integration and its version
history. The API does not support separate deletion of one secret field.

## External secret references

An external reference stores a backend name and locator. The integration
version does not contain the resolved value.

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

API reads return the backend and locator. They never return the resolved value.

| Operation           | Reference behavior                                |
| ------------------- | ------------------------------------------------- |
| Save                | Validates the format and backend without a fetch  |
| **Test connection** | Resolves the current draft for supported kinds    |
| Session creation    | Resolves references for every enabled integration |

**Environment variables** does not support **Test connection**. Make sure that
its locators exist before you save them.

A missing backend or resolver error stops the operation. Logs omit plaintext,
locators, and provider error details. The API currently reports provider
outages and throttling as HTTP 422, not HTTP 503.

### AWS Secrets Manager

Set a region to enable the `aws-sm` backend:

```bash
MARIMOHUB_SECRETS_AWS_REGION=us-east-1
```

If the AWS environment supplies the region, enable the resolver with:

```bash
MARIMOHUB_SECRETS_AWS=true
```

The resolver uses the default AWS credential chain. For a non-AWS deployment,
you can set static credentials:

```bash
MARIMOHUB_SECRETS_AWS_ACCESS_KEY_ID=...
MARIMOHUB_SECRETS_AWS_SECRET_ACCESS_KEY=...
```

Static credentials do not enable the resolver. If the resolver is enabled, set
both credential variables or neither. A partial pair then causes startup to
fail. If the resolver is disabled, the credential variables are ignored.

A locator uses `secret-id-or-arn[#json-key]`. The optional key selects one
string from a JSON secret. Omit it to resolve the complete JSON object.

The hub needs `secretsmanager:GetSecretValue`. It does not write to AWS Secrets Manager.

## Environment variable bundles

The **Environment variables** integration supports three inputs:

- Plain variables store non-secret strings.
- Secret variables store one protected scalar per environment name.
- Secret JSON bundles expand a protected JSON object into multiple environment variables.

Environment variable names, prefixes, and bundle names use uppercase letters,
digits, and underscores.

The hub validates plain-variable and secret-variable names during save. It
validates bundle JSON, generated names, and collisions during session creation.
An invalid bundle can be saved, but new sessions fail until you correct it.

Each bundle name must be unique and stable. The hub uses it to keep the correct
value after you delete or reorder rows.

If you change the stable name, enter the inline value again before you save.

## Editing through the API

The API updates the complete integration configuration. It does not provide
separate operations for each secret field.

Before an update, read the integration and its ETag. Send the ETag as `If-Match`
with the complete configuration. Managed markers keep unchanged inline values.
References must include their complete backend and locator.

Copies decrypt and encrypt inline values for the destination. They keep
external references unchanged. Organization integrations use the same secret
sources as project integrations.

## Upgrade note

The standalone project-secret subsystem was unreleased. This change removes its
routes, bucket objects, and `MARIMOHUB_SECRETS_BACKEND`. No migration is provided.
