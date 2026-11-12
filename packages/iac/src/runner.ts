import { ApplyError, createHub, IacError } from './index';
import type { Declaration } from './index';

export interface RunnerEnvironment {
	get(name: string): string | undefined;
	out(text: string): void;
	err(text: string): void;
}

export async function runIntegrations(
	specs: readonly Declaration[],
	environment: RunnerEnvironment,
	args: readonly string[] = [],
): Promise<number> {
	const json = args.includes('--json');
	try {
		const unknown = args.filter((arg) => !['--json', '--plan', '--check'].includes(arg));
		if (unknown.length > 0 || (args.includes('--plan') && args.includes('--check')))
			throw new IacError(
				'USAGE_ERROR',
				'Use --plan, --check, or no mode flag; add --json for structured output.',
			);
		const required = (name: string) => {
			const value = environment.get(name);
			if (!value) throw new IacError('ENV_ERROR', `Missing environment variable: ${name}`);
			return value;
		};
		const integrations = createHub({
			url: required('MARIMOHUB_URL'),
			token: required('MARIMOHUB_TOKEN'),
		}).project(required('MARIMOHUB_PROJECT_ID')).integrations;
		const plan = await integrations.plan(specs);
		if (args.includes('--plan') || args.includes('--check')) {
			environment.out(json ? JSON.stringify(plan) : plan.summary());
			return args.includes('--check') && plan.items.some((item) => item.action !== 'unchanged')
				? 2
				: 0;
		}
		const report = await integrations.apply(plan);
		environment.out(
			json
				? JSON.stringify(report)
				: report.completed.map((item) => `${item.action}: ${item.kind}/${item.name}`).join('\n'),
		);
		return 0;
	} catch (error) {
		const message = error instanceof IacError ? error.message : 'Integration script failed.';
		if (json)
			environment.out(
				JSON.stringify(error instanceof ApplyError ? error.report : { error: message }),
			);
		environment.err(message);
		return 1;
	}
}
