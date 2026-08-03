---
description: Choose how notebook sessions receive data-source configuration, secret values, and short-lived cloud credentials.
---

# Environment & cloud access

Open a project and select **Environment & cloud access**. The dialog has two areas:

- **Integrations** stores versioned configuration for data sources and environment variables.
- **Cloud access** supplies short-lived credentials through Workload Identity Federation (WIF).

Project admins can make changes. Other project members can view the cloud-access status.
Cloud access supplies credentials to notebook sessions. It does not control project roles or permissions.

## Choose a method

| Requirement                                           | Use                                   | The hub stores                                |
| ----------------------------------------------------- | ------------------------------------- | --------------------------------------------- |
| Configure a supported service                         | Typed integration                     | Versioned configuration                       |
| Add project-specific variables                        | **Environment variables** integration | Plain values and secret fields                |
| Let the hub store a secret                            | Inline encrypted value                | Ciphertext in each integration version        |
| Keep a secret in an external manager                  | External secret reference             | The backend name and locator                  |
| Access a cloud service without a long-lived cloud key | WIF under **Cloud access**            | The project opt-in and federation target only |

When a typed integration exists, use it. It provides stable environment names and client configuration files.

Use **Environment variables** for application-specific values. A secret JSON bundle can create several variables from one object.

When the cloud provider supports WIF, use it. WIF supplies temporary credentials and does not store a cloud key.

## When changes apply

Each save creates an immutable integration version. New and restarted sessions
use the latest enabled versions. Running sessions keep their initial configuration.

Integration variables have lower precedence than hub, WIF, AI, and marimo
configuration. An integration cannot replace a hub-controlled variable.

A restricted viewer sandbox does not receive integration or WIF credentials.

## Testing and failures

Saving an external reference validates its format and backend. It does not fetch
the value from the provider.

**Test connection** resolves the current draft for supported integration kinds.
**Environment variables** does not support this test.

Session creation resolves every enabled reference. A resolution or rendering
error stops the session without disclosing secret values or locators.

Before you save an **Environment variables** reference, make sure that the
locator exists and the hub identity can read it.

## Related guides

- [Integrations](./integrations.md)
- [Integration secret sources](./integration-secrets.md)
- [Workload Identity Federation](./workload-identity-federation.md)
