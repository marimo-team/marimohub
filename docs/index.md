---
layout: home
description: Self-hostable, provider-agnostic storage, compute, and identity for running marimo notebooks.

hero:
  name: marimohub
  text: Self-hostable marimo notebooks
  tagline: A provider-agnostic platform to store, manage, and run marimo notebooks. No database — bring your own storage, compute, and identity.
  actions:
    - theme: brand
      text: Get started
      link: /getting-started
    - theme: alt
      text: Deployment options
      link: /deployment-options
    - theme: alt
      text: View on GitHub
      link: https://github.com/marimo-team/marimohub

features:
  - icon: 🔌
    title: Bring your own backends
    details: Choose your storage, compute, and identity providers — and switch them later without migrating your notebooks.
  - icon: 🗄️
    title: No database to run
    details: Everything lives in one object store. Nothing extra to provision, scale, or back up.
  - icon: ☁️
    title: Deploy anywhere
    details: Run it on CoreWeave, AWS, GCP, or fully serverless on Cloudflare. The same build, configured to your stack.
  - icon: 🔐
    title: Single sign-on
    details: Connect any OpenID Connect provider — Google, Okta, Auth0 — and restrict access by email domain.
  - icon: 🤖
    title: Managed AI, no keys
    details: Optionally front any OpenAI-compatible provider so every notebook's AI assistant just works — the real key stays server-side.
---

## What marimohub is

marimohub is a self-hostable platform for storing, managing, and running marimo
notebooks. Bring your own object storage, sandbox provider, and identity system;
the hub provides the web app, API, version history, access control, and kernel
lifecycle.

<div class="home-wizard">

## Configure your deployment

Pick your storage, compute, and auth backends to generate a clearly marked config
scaffold (`.env`, Helm, or Docker Compose) and the equivalent library wiring code
— live, no install required.

For a terminal-only equivalent, use the
[non-interactive configuration scaffold](/getting-started#non-interactive-configuration-scaffold).

<DeploymentWizard />

</div>
