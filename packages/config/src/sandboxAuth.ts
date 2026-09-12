import { parseEnumOr } from './env';

export function parseSandboxAuth(raw: string | undefined): 'on' | 'off' {
	return parseEnumOr(
		{ MARIMOHUB_SANDBOX_AUTH: raw },
		'MARIMOHUB_SANDBOX_AUTH',
		['on', 'off'] as const,
		'off',
		{
			docs: 'docs/security.md',
		},
	);
}
