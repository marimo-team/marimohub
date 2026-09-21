# Quickstart: Local compute and local storage

> [!CAUTION]
> For local evaluation only. Dev authentication signs every visitor in as
> `dev@localhost`. Keep the UI and kernel ports bound to loopback.

Run marimohub with filesystem storage and kernels inside one Docker Compose container.

## Start the stack

```sh
git clone https://github.com/marimo-team/marimohub.git
cd marimohub/examples/docker-compose/local-compute
docker compose up -d --build
```

## Expected result

- marimohub is available at http://localhost:3000
- local storage is mounted under `./storage`
- local compute sandboxes run inside the compose container

## Stop the stack

```sh
docker compose down
```
