---
description: Choose how notebook sessions receive data-source configuration, secret values, and short-lived cloud credentials.
---

# Environment & cloud access

Open a project and select **Environment & cloud access**. The dialog has two areas:

- **Integrations** stores versioned configuration for data sources and environment variables.
- **Cloud access** supplies short-lived credentials through Workload Identity Federation (WIF).

Project managers can make changes. Other project members can view the cloud-access status.
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

Use **Environment variables** for application and marimo settings, such as
`MARIMO_OUTPUT_MAX_BYTES=10000000`. JSON secret bundles supply multiple variables.

A project's `MARIMO_*` values are defaults. When the sandbox image or the deployment
already sets the same variable, that value wins. A project can only fill in marimo
settings that the operator did not pin.

Reserved names: the `MARIMOHUB_` and `_MARIMO_` prefixes, `XDG_CONFIG_HOME`,
`XDG_CACHE_HOME`, `XDG_STATE_HOME`, and the marimo settings that the sandbox image
pins (see [Sandbox environment](#sandbox-environment)). Shell, startup hook, and cloud
credential restrictions also apply. Saving a variable with a reserved name fails, and a
secret bundle that expands to a reserved name stops the session start.

When the cloud provider supports WIF, use it. WIF supplies temporary credentials and does not store a cloud key.

## When changes apply

Each save creates an immutable integration version. New and restarted sessions
use the latest enabled versions. Running sessions keep their initial configuration.

Integration variables have lower precedence than hub, WIF, AI, and marimo
configuration. An integration cannot replace a hub-controlled variable, and its
`MARIMO_*` values cannot replace the sandbox image's values.

A restricted viewer sandbox does not receive integrations or WIF credentials. This
includes marimo settings that come from an **Environment variables** integration.

## Sandbox environment

The hub sets these variables in a sandbox. Notebook code can read them; projects cannot set them.

| Variable                                                                                                        | Purpose                                                                                                                                | Sessions                                                         |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `MARIMOHUB_CONTEXT_FILE`                                                                                        | Path to the JSON [publication context](./apps.md#published-urls-inside-the-sandbox) with the public and notebook URLs.                 | Editor, app, preview, surfaces                                   |
| `MARIMOHUB_INTEGRATIONS_DIR`                                                                                    | Directory with the rendered [integration](./integrations.md#using-an-integration-in-a-notebook) files and `manifest.json`.             | Editor, app, preview, job, surfaces; when an integration renders |
| `MARIMOHUB_KERNEL_URL`                                                                                          | URL of the session's marimo kernel, reachable from inside the sandbox.                                                                 | Surfaces only                                                    |
| `MARIMOHUB_KERNEL_TOKEN_FILE`                                                                                   | Path to the kernel access token. Empty when sandbox authentication is off.                                                             | Surfaces only                                                    |
| `MARIMOHUB_BRIDGE_PARENT_ORIGIN`, `MARIMOHUB_BRIDGE_INSTALL_TIMEOUT_MS`, `MARIMOHUB_BRIDGE_STARTUP_DEADLINE_MS` | Configuration for the [notebook bridge](./apps.md#notebooks-with-query-parameters) that syncs query parameters and paths with the hub. | Editor, app, preview                                             |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_ENDPOINT_URL_S3`, `AWS_REGION`          | Temporary credentials from [Workload Identity Federation](./workload-identity-federation.md#what-the-notebook-receives).               | Editor, app, preview, job, surfaces; when WIF is enabled         |
| `XDG_CONFIG_HOME`                                                                                               | Location of the hub-written `marimo.toml`. The hub always sets it.                                                                     | Editor                                                           |
| `XDG_CACHE_HOME`, `XDG_STATE_HOME`                                                                              | marimo logs and state under `/tmp`, outside the workspace. The sandbox image can set its own values.                                   | Editor                                                           |
| `MARIMO_VERSION`, `MARIMO_SKIP_UPDATE_CHECK`, `_MARIMO_APP_OVERLOAD_AUTO_DOWNLOAD`                              | Pinned by the reference [sandbox image](./sandbox-image.md), not by the hub process.                                                   | All                                                              |

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
