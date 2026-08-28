# Remote development

marimohub can broker SSH access to an exclusive editor sandbox. The CLI sends SSH bytes through an authenticated WebSocket relay.

The relay does not return the provider address or the sandbox ID to the client. Remote development is off by default.

## Requirements

Remote development requires all of these conditions:

- The editor sandbox policy is `exclusive`.
- The compute backend supports brokered TCP connections.
- The sandbox image implements the remote-development image contract.
- The session is a persistent edit session.
- The caller owns the session.

Docker, Podman, Kubernetes, and Modal support the connector. Other compute backends reject an enabled SSH configuration.

## Build the image

Build and publish a dedicated image from `images/marimo-sandbox-remote-development`.

```sh
docker build \
  --build-arg BASE_IMAGE=ghcr.io/marimo-team/marimo-sandbox:latest \
  --tag registry.example/marimo-sandbox:remote-development \
  images/marimo-sandbox-remote-development
docker push registry.example/marimo-sandbox:remote-development
```

The image keeps the non-root `appuser`. It adds OpenSSH and the `marimohub-ssh` runtime helper.

The helper creates host keys and authorized keys in `/tmp/marimohub-ssh`. Workspace snapshots do not include this directory.

## Configure the Hub

Set the compute image and enable SSH for that exact image reference.

```sh
MARIMOHUB_COMPUTE_IMAGE=registry.example/marimo-sandbox:remote-development
MARIMOHUB_EDITOR_SANDBOX_SHARING=exclusive
MARIMOHUB_REMOTE_DEVELOPMENT=ssh
MARIMOHUB_REMOTE_DEVELOPMENT_IMAGES=registry.example/marimo-sandbox:remote-development
```

`MARIMOHUB_REMOTE_DEVELOPMENT_IMAGES` accepts a comma-separated list. Each value must match a configured compute image.

If the configuration is unsafe or inconsistent, the server stops during startup. Existing sessions without an image record require a restart.

## Connect

Install the `mohub` CLI, OpenSSH, VS Code, and the VS Code Remote-SSH extension.

Open the notebook session menu in marimohub. Select **Connect from VS Code**, then run the displayed command.

```sh
mohub sessions code --pid PROJECT_ID --nid NOTEBOOK_ID --sid SESSION_ID
```

Use `mohub sessions ssh` with the same arguments for an interactive terminal.

The CLI creates one Ed25519 key for each profile. It stores the private key in the local application-data directory.

The CLI also installs a managed OpenSSH entry. The entry contains no Hub credential.

Each connection refreshes the public key for a maximum of 10 minutes. The CLI pins the sandbox host key in a managed `known_hosts` file.

## Persistence

The connection dialog states the persistence mode for the session:

- `workspace`: marimohub captures files under `/workspace` with the current workspace policy.
- `source`: marimohub saves only the supported source files.
- `none`: marimohub discards edits unless the user uses the Git or change-request workflow.

## Security controls

The sandbox accepts public-key authentication only. It disables root login, passwords, PAM, agent forwarding, X11 forwarding, remote forwarding, and user RC files.

Local TCP forwarding remains available for VS Code. The Hub checks session access every 30 seconds and closes access after a permission change.

An active relay refreshes a 90-second development lease. This lease prevents the session reaper from stopping SSH-only work.

Prepare, connect, and disconnect events contain user and session identifiers. Logs never contain keys, credentials, commands, or SSH payloads.

## Backend behavior

Docker and Podman publish port `2222` on the daemon host's loopback interface, even when kernel ports use a public bind. Remote Docker contexts, Podman connections, and network-based `DOCKER_HOST` or `CONTAINER_HOST` endpoints are not supported because the Hub cannot securely reach that loopback port. The server rejects SSH configuration with these remote daemon connections.

Kubernetes adds port `2222/TCP` to the per-session ClusterIP Service. It does not add an Ingress for SSH.

Modal creates an unencrypted raw TCP tunnel for port `2222`. The adapter keeps the tunnel address inside the server process.

CoreWeave and W&B remain off until their environment-gated TCP contracts pass. Cloudflare, E2B, and local compute do not implement this connector.
