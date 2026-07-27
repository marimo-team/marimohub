---
description: Run marimohub, filesystem storage, and Docker kernels on one Linux host.
---

# Deploying on a single instance

Run everything on one Linux machine — a beefy cloud VM (AWS EC2, GCP Compute
Engine, Hetzner) or an on-prem server. The hub stores notebooks with the
[`fs` storage backend](../storage.md#filesystem-setup) in a directory on a local
volume and runs kernels with the
[`docker` compute backend](../compute.md#docker), one container per kernel. No
object store, no cluster — the only external dependencies are DNS and your OIDC
provider.

> Outline — not yet a tested recipe. Contributions welcome.

## When this fits

- A team on one machine you can size generously — kernels share its CPU and RAM.
- On-prem or single-tenant environments with no object store available.
- You accept **one replica** (required by `fs` storage) and one host of kernel
  capacity. For HA or horizontal scale, use [Helm](./helm.md) or
  [Kubernetes](./kubernetes.md) with `s3`/`gcs` instead.

## Architecture

Only the reverse proxy is public; everything else binds to loopback:

```
internet ──▶ :443 Caddy (TLS) ──▶ 127.0.0.1:3000 hub container
                                     ├─▶ /var/lib/marimohub        (fs storage root)
                                     └─▶ /var/run/docker.sock ──▶ kernel containers
                                                                  (127.0.0.1:<os-assigned port>)
```

Kernel exposure is `proxy`: the browser reaches kernels **through the hub** at
`https://hub.example.com/proxy/<token>/…`, behind the hub's auth. With the
`docker` backend kernel URLs are plain `http://host:port`, which browsers block
from an HTTPS page — so on a TLS single box, proxy exposure is the mode that
works, and it keeps kernel ports off the network entirely.

::: warning Proxy exposure is for trusted users
Proxied kernels are same-origin with the app, so a malicious notebook can script
the control plane (XSS). Run this recipe for a team you trust. See
[Security → Kernel exposure](../security.md#kernel-exposure).
:::

## Image — add the `docker` CLI

The published image (`ghcr.io/marimo-team/marimohub`) does not ship the `docker`
CLI the compute backend shells out to. Add the static CLI in a small derived
image (no daemon — the host's daemon is reached through the mounted socket):

```dockerfile
# Dockerfile
FROM ghcr.io/marimo-team/marimohub:latest
ADD https://download.docker.com/linux/static/stable/x86_64/docker-28.3.2.tgz /tmp/docker.tgz
RUN tar -xzf /tmp/docker.tgz -C /tmp \
	&& mv /tmp/docker/docker /usr/local/bin/docker \
	&& rm -rf /tmp/docker*
```

You also need a [sandbox image](../sandbox-image.md) (marimo + uv + python)
pulled or published somewhere the host can reach.

## Configuration

```bash
# marimohub.env — contains secrets; keep it root-only (chmod 600)

# --- Storage: a directory on this machine ---
MARIMOHUB_STORAGE_BACKEND=fs
MARIMOHUB_STORAGE_FS_ROOT=/var/lib/marimohub

# --- Compute: one container per kernel on this machine ---
MARIMOHUB_COMPUTE_BACKEND=docker
MARIMOHUB_COMPUTE_IMAGE=ghcr.io/orgname/marimo-sandbox:latest
MARIMOHUB_COMPUTE_DOCKER_HOST=localhost       # where the hub reaches kernels
MARIMOHUB_COMPUTE_DOCKER_BIND_HOST=127.0.0.1  # kernel ports never leave loopback

# --- Kernel exposure: through the hub (single domain, kernels stay private) ---
MARIMOHUB_SANDBOX_EXPOSURE=proxy
MARIMOHUB_SANDBOX_PROXY_ACK_UNTRUSTED=true    # see Security → Kernel exposure
MARIMOHUB_APP_BASE_URL=https://hub.example.com

# --- Auth: OIDC (see Auth for provider-specific setup) ---
MARIMOHUB_AUTH_BACKEND=oidc
MARIMOHUB_AUTH_OIDC_ISSUER=https://accounts.example.com
MARIMOHUB_AUTH_OIDC_CLIENT_ID=<client-id>
MARIMOHUB_AUTH_OIDC_CLIENT_SECRET=<client-secret>
MARIMOHUB_AUTH_OIDC_REDIRECT_URI=https://hub.example.com/api/auth/callback
MARIMOHUB_AUTH_SESSION_SECRET=<openssl rand -base64 32>
MARIMOHUB_AUTH_ALLOWED_EMAIL_DOMAINS=example.com

# --- The only replica also runs background maintenance ---
MARIMOHUB_RUN_MAINTENANCE=true
```

## Run it

One compose file for the hub and the TLS proxy. Both use the host network so the
hub can reach kernel ports on `127.0.0.1` and Caddy can reach the hub:

```yaml
# docker-compose.yml
services:
  hub:
    build: . # the Dockerfile above
    network_mode: host # serves :3000; reaches kernels on 127.0.0.1
    restart: unless-stopped
    env_file: marimohub.env
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /var/lib/marimohub:/var/lib/marimohub

  caddy:
    image: caddy:2
    network_mode: host # binds :80/:443
    restart: unless-stopped
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data # ACME certificates

volumes:
  caddy-data:
```

```text
# Caddyfile — TLS via Let's Encrypt, websockets proxied automatically
hub.example.com {
	reverse_proxy 127.0.0.1:3000
}
```

```bash
docker compose up -d --build
```

Point DNS for `hub.example.com` at the machine and open only ports 80 and 443.

## Provider notes

### AWS (EC2)

```bash
aws ec2 run-instances \
  --instance-type m7i.2xlarge --image-id <ubuntu-24.04-ami> \
  --block-device-mappings 'DeviceName=/dev/sdf,Ebs={VolumeSize=200,VolumeType=gp3}' \
  --security-group-ids <sg-allowing-80-443> --subnet-id <public-subnet>
```

Format and mount the extra gp3 volume at `/var/lib/marimohub` so notebook data
lives on its own device. Attach an Elastic IP and a Route 53 record. Use a Data
Lifecycle Manager snapshot schedule on the data volume as your backup, and SSM
Session Manager instead of public SSH.

### GCP (Compute Engine)

```bash
gcloud compute instances create marimohub \
  --machine-type n2-standard-8 \
  --image-family ubuntu-2404-lts-amd64 --image-project ubuntu-os-cloud \
  --create-disk name=marimohub-data,size=200GB,type=pd-balanced,auto-delete=no \
  --tags http-server,https-server
```

Mount the data disk at `/var/lib/marimohub`, reserve a static external IP, and
attach a resource-policy snapshot schedule to the data disk for backups.

### Hetzner (or on-prem)

```bash
hcloud server create --name marimohub --type cpx51 --image ubuntu-24.04
hcloud volume create --name marimohub-data --size 200 --server marimohub \
  --automount --format ext4
```

Mount the volume at `/var/lib/marimohub` and restrict a Hetzner firewall to
80/443. A dedicated AX server gives kernels far more headroom for the price —
same recipe, with the storage root on the NVMe RAID. On-prem is identical: any
Linux host with Docker; keep the root on redundant disks and ship backups
off-box (for example restic or borgmatic to a Storage Box or NAS).

## Backups and upgrades

The storage root **is the database** — objects appear as plain files
(`_system/…`, `projects/…`). Everything except the catalog pointer is immutable
or append-only, so both block-level volume snapshots (the low-effort default
above) and file-level tools (restic, borg, rsync) work well. Restore = put the
files back and start the server. See
[Operations → Backups & restore](../operations.md#backups-restore).

To upgrade: bump the base image tag in the Dockerfile (or, if you track
`latest`, run `docker compose build --pull`), then `docker compose up -d`. A
single replica means a few seconds of downtime; data on the volume is untouched.

## Validate

1. Check `https://hub.example.com/api/health`.
2. In the startup logs, expect a **non-fatal** preflight warning that `fs`
   storage enforces conditional writes within one process — the single-replica
   reminder.
3. Sign in through your OIDC provider.
4. Create a project and notebook, then start a kernel — a sandbox container
   appears in `docker ps`, published on `127.0.0.1`.
5. Confirm `find /var/lib/marimohub -type f` shows `_system/…` and `projects/…`
   files.
6. Restart the hub container and confirm the notebook survives.

## Production cautions

- **Never run a second hub replica** (or a second compose stack) against the
  same storage root — concurrent edits can lose catalog updates.
- Keep the storage root on **one filesystem** — writes rely on atomic renames,
  which fail across mount points.
- Proxy exposure serves untrusted notebook code same-origin with the app —
  trusted users only.
- The Docker socket is root-equivalent on the host. Only the hub container gets
  it; don't reuse the machine for unrelated workloads.
- Keep `MARIMOHUB_COMPUTE_DOCKER_BIND_HOST=127.0.0.1` and expose only 80/443.
- Capacity is one machine. `MARIMOHUB_MAX_SESSIONS_PER_USER` (default 10) caps
  concurrent kernels per user.

## Troubleshooting

See [Troubleshooting](../troubleshooting.md), especially startup failures,
storage preflight failures, and kernel startup failures.

## See also

[Storage](../storage.md) · [Compute](../compute.md) · [Auth](../auth.md) ·
[Security](../security.md) · [Configuration](../configuration.md)
