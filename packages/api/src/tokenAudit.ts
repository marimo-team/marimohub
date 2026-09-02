import type { Context } from 'hono';
import type { CreatedToken } from '@marimo-hub/core';
import { appendAudit } from './log';
import type { HonoEnv } from './context';

export async function auditTokenCreation(
	c: Context<HonoEnv>,
	credential: CreatedToken,
): Promise<void> {
	const { record } = credential;
	await appendAudit(
		{
			requestId: c.get('requestId'),
			method: c.req.method,
			path: c.req.path,
			userId: record.user_id,
		},
		'token.create',
		() =>
			c.get('deps').services.events.append({
				event: 'token.create',
				actor: record.user_id,
				token_id: record.id,
				token_name: record.name,
				...(record.grant !== undefined ? { grant: record.grant } : {}),
			}),
	);
}
