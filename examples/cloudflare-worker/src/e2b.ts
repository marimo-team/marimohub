/**
 * OPT-IN: run the E2B compute backend (`@marimo-hub/compute-e2b`) inside this
 * Worker instead of (or alongside, see tieredCompute.ts) Cloudflare Sandboxes.
 *
 * The library's default E2B client loads the `e2b` SDK via a computed `import('e2b')`
 * (kept optional + unbundled for the lean Node server image), which can't bundle
 * into a Cloudflare Worker — every module there must be statically bundled. So we
 * `import { Sandbox } from 'e2b'` at the top level and inject it into the SAME
 * `createE2bClient`, reusing all its wrapper logic (v2 command + list shapes,
 * non-zero-exit handling) rather than reimplementing it.
 *
 * Wire it up: `new E2bCompute(config, createWorkersE2bClient(config))` as the
 * `compute` in index.ts, with `config = { apiKey: env.E2B_API_KEY, template:
 * env.E2B_TEMPLATE }`. Build the template from ../../e2b-template. See
 * docs/setup/compute/e2b.md.
 */
import { Sandbox } from 'e2b';
import { createE2bClient } from '@marimo-hub/compute-e2b';
import type { E2bClient, E2bConfig } from '@marimo-hub/compute-e2b';

export function createWorkersE2bClient(config: E2bConfig): E2bClient {
	return createE2bClient(config, () => Promise.resolve({ Sandbox }));
}
