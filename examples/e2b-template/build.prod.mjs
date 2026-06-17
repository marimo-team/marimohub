/**
 * Build + deploy the marimo kernel template to E2B (build system v2).
 *
 * Run from this directory with the E2B API key in the environment:
 *   E2B_API_KEY=… pnpm build:template     # or: node build.prod.mjs
 *
 * The build prints the template id; set the template name (or id) as your
 * deployment's `MARIMOHUB_COMPUTE_E2B_TEMPLATE` (or `E2B_TEMPLATE` on Workers).
 */
import { Template } from 'e2b';
import { template } from './template.mjs';

const name = process.env.E2B_TEMPLATE_NAME ?? 'marimo-sandbox';

const info = await Template.build(template, name, {
	cpuCount: 2,
	memoryMB: 2048,
	onBuildLogs: (log) => process.stdout.write(`${log.message ?? log}\n`),
});

process.stdout.write(`Built E2B template "${info.name}" (${info.templateId}).\n`);
