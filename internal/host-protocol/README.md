# Upstream host contract

`vendor/` contains only the generated OpenAPI contract, three fixtures used by our tests,
the upstream license, and the commit SHA in `REVISION`. Regular tests need no network or marimo checkout.

The hub supports the subset in [the host guide](../../docs/host-protocol.md).
The [upstream specification](https://github.com/marimo-team/marimo/blob/ce8f85a2635fe1b79302f8b0fd9af1d7e0f85474/protocols/host/spec.md)
describes the pinned contract. Experimental operations are not advertised.

## Refresh

From a clean marimo checkout at the desired commit:

```sh
npm install --prefix /path/to/marimo/packages/host-protocol --omit=dev --ignore-scripts --package-lock=false
node scripts/sync-host-protocol.mjs /path/to/marimo
pnpm --filter @marimo-hub/host-protocol test
```

The script replaces `vendor/` with the selected files. Review the contract diff and update the
integration and pinned specification links. Vitest checks route identifiers and identity rewriting
against these files. Hub tests cover authorization, retries, capture, and sandbox lifecycle.

## Upstream conformance

Run the upstream suite from a separate checkout under the gitignored `.context/` directory:

```sh
git clone https://github.com/marimo-team/marimo.git .context/marimo-host-conformance
git -C .context/marimo-host-conformance checkout --detach "$(cat internal/host-protocol/vendor/REVISION)"
npm install --prefix .context/marimo-host-conformance/packages/host-protocol --omit=dev --ignore-scripts --package-lock=false
cd .context/marimo-host-conformance
uv run --locked --project protocols/host/conformance \
  pytest -c protocols/host/conformance/pyproject.toml \
  protocols/host/conformance protocols/host/experimental
```

Without `--record`, live checks are skipped. To run them, append `--record /path/to/host.json` for a
disposable host. These checks create and modify notebooks and runtimes. The hub has no local
discovery record and does not claim full loopback-host conformance.
