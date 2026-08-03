---
description: Choose how notebook sessions receive data-source configuration, secret values, and short-lived cloud credentials.
---

# Environment & access

Open a project and select **Environment & access**. This dialog has two areas:

- **Integrations** stores versioned configuration for data sources and environment variables.
- **Cloud access** vends short-lived credentials through Workload Identity Federation (WIF).

Project admins can change both areas. Other project members can see the current cloud-access status.

## Choose a method

| Requirement                                                         | Method                                | Stored by marimohub                                                | When the value becomes available                                  |
| ------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Configure a supported database, catalog, engine, or storage service | Typed integration                     | Versioned configuration and encrypted fields or reference metadata | When a new editor or shared app session starts                    |
| Add project-specific environment variables                          | **Environment variables** integration | Plain values and protected secret fields                           | When a new editor or shared app session starts                    |
| Store a secret value in marimohub                                   | Inline encrypted value                | An AES-256-GCM ciphertext envelope                                 | During session creation, or during a supported connection test    |
| Keep a secret in an external manager                                | External secret reference             | The backend name and locator                                       | During session creation, or during a supported connection test    |
| Access a supported cloud service without a static key               | WIF under **Cloud access**            | The project opt-in and federation target                           | When a new session receives credentials that expire automatically |

Use a typed integration when one exists. It supplies stable environment names and configuration files for its client library.

Use the **Environment variables** integration for application-specific variables. Secret JSON bundles can expand one object into many variables.

Use WIF for cloud access when the cloud provider supports it. WIF does not store or resolve a static cloud key.

## Saving and testing changes

Each integration save creates an immutable configuration version. Replacing an
inline value creates new ciphertext. The old ciphertext stays in the version
history until you delete the entire integration.

The API updates an integration as one versioned resource. It does not provide
separate operations for each secret field. ETag checks prevent a stale edit
from replacing a newer integration version.

**Test connection** checks the current draft only for integration kinds that
support a connection test. **Environment variables** does not support this
test. Saving a reference checks its backend and required fields. It does not
ask the provider to validate or fetch the value. Session creation resolves all
enabled references. It stops if any value cannot be resolved.

Before you save an external reference for **Environment variables**, verify
the locator and the hub identity's access in the external manager.

## Precedence and session lifetime

Integration variables have lower precedence than hub, WIF, AI, and marimo configuration. An integration cannot replace a hub-controlled variable.

Configuration changes apply to new or restarted sessions. A running session keeps the configuration that it received at creation time.

Viewer credential restrictions do not change. A restricted viewer sandbox does not receive integration or WIF credentials.

## Related guides

- [Integrations](./integrations.md)
- [Integration secret sources](./integration-secrets.md)
- [Workload Identity Federation](./workload-identity-federation.md)
