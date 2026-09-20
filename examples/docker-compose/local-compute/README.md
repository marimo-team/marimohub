# Quickstart: Local compute and local storage

> [!CAUTION]
> This example is for demonstration purposes only. It provides a working local
> setup for evaluating marimohub, but it is not production-ready.

Use this example to run marimohub with local storage and local compute in Docker
Compose.

## Start the stack

```sh
git clone https://github.com/marimo-team/marimohub.git
cd examples/docker-compose/local-compute
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
