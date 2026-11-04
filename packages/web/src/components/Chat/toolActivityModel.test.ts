import { describe, expect, it } from 'vitest';
import type { ConversationPermission } from '@/api/conversations';
import { messageToolEntries, toolEntries } from './toolActivityModel';
import type { PermissionPart, ToolPart } from './toolActivityModel';

const tool = {
	type: 'dynamic-tool',
	toolName: 'create_notebook',
	toolCallId: 'call-1',
	state: 'output-available',
	input: { title: 'Costs' },
	output: 'Permission was not granted.',
} as const satisfies ToolPart;

function permissionPart(status: ConversationPermission['status']): PermissionPart {
	return {
		type: 'data-permission',
		data: {
			id: 'permission-1',
			tool_call_id: 'call-1',
			action: 'Create notebook',
			status,
			details: [],
			can_remember: false,
			scope: { key: 'tool:create_notebook', label: 'this project' },
			kind: 'tool',
			expires_at: '2026-11-03T12:05:00Z',
		},
	};
}

describe('toolEntries', () => {
	it.each(['denied', 'expired', 'cancelled', 'unavailable'] as const)(
		'marks a call refused at the consent gate (%s) as failed despite its output',
		(status) => {
			const [entry] = toolEntries([tool], [permissionPart(status)]);
			expect(entry).toMatchObject({ id: 'call-1', status: 'failed', permission: { status } });
		},
	);

	it.each(['allowed', 'remembered'] as const)('keeps a %s call succeeded', (status) => {
		const [entry] = toolEntries([tool], [permissionPart(status)]);
		expect(entry?.status).toBe('succeeded');
	});

	it('reports the tool state while consent is still open', () => {
		const [entry] = toolEntries(
			[{ ...tool, state: 'input-available', output: undefined }],
			[permissionPart('open')],
		);
		expect(entry?.status).toBe('running');
	});

	it('uses the latest consent card for a call', () => {
		const [entry] = toolEntries([tool], [permissionPart('open'), permissionPart('denied')]);
		expect(entry?.status).toBe('failed');
	});
});

describe('messageToolEntries', () => {
	it('counts a refused call as failed in the message summary', () => {
		const entries = messageToolEntries({
			id: 'reply',
			role: 'assistant',
			parts: [{ type: 'text', text: 'Creating it.' }, tool, permissionPart('denied')],
		});
		expect(entries.map((entry) => entry.status)).toEqual(['failed']);
	});
});
