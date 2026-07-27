---
description: Task-oriented entry point, source-of-truth rules, and non-interactive workflows for agents working with marimohub.
---

# Agent guide

Use this page when operating from a terminal, code-generation tool, or agent
without the interactive docs UI. These docs follow the current source tree and
intentionally include the newest available capabilities.

## Choose the route for the task

| Task                                      | Start here                                                                                                              |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Run a local evaluation                    | [Testing locally](./testing-locally.md)                                                                                 |
| Generate configuration without the wizard | [Getting started → Non-interactive configuration scaffold](./getting-started.md#non-interactive-configuration-scaffold) |
| Select storage, compute, or auth          | [Storage](./storage.md), [Compute](./compute.md), [Auth](./auth.md)                                                     |
| Deploy the server                         | [Deployment options](./deployment-options.md), then [Deploying](./deploying/README.md)                                  |
| Build or call an API client               | [API & client](./api.md) and [`/openapi.yaml`](/openapi.yaml)                                                           |
| Authenticate automation                   | [API tokens](./api-tokens.md)                                                                                           |
| Diagnose a deployment                     | [Troubleshooting](./troubleshooting.md) and [Operations](./operations.md)                                               |

## Source-of-truth order

When two summaries appear to disagree, use these sources in order:

1. [`CONFIG_SPEC`](https://github.com/marimo-team/marimohub/blob/main/packages/config/src/spec.ts)
   for backend selectors and `MARIMOHUB_*` variables. It generates the
   [Configuration](./configuration.md) reference.
2. [`/openapi.yaml`](/openapi.yaml) for HTTP paths, schemas, authentication
   schemes, and response envelopes.
3. The backend pages for provisioning steps and operational constraints.
4. The platform deployment guide for topology-specific wiring.

At runtime, `GET /api/v1/version` reports the deployed backends and
`GET /api/v1/capabilities` reports server limits. Prefer those responses over
assuming a deployment matches a source checkout.

## Non-interactive workflow

1. Select one storage, compute, and auth backend from their complete tables.
2. Copy the [configuration scaffold](./getting-started.md#non-interactive-configuration-scaffold)
   and replace every `_replace_me_` value, using the adjacent `# e.g.` comment
   when present.
3. Add backend-specific variables from the generated
   [Configuration](./configuration.md) reference.
4. For Helm, replace `<VERSION>` with an existing GitHub release tag without
   its leading `v`.
5. Validate `/api/health`, sign in or use a PAT, create a project, start a
   kernel, and verify a saved notebook survives a restart.

Interactive components are conveniences only. Every required provisioning and
validation step has a Markdown equivalent linked above, so raw page Markdown
and `llms-full.txt` remain sufficient.
