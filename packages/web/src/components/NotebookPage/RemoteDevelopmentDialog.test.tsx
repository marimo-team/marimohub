import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { Session } from '@/types';
import { RemoteDevelopmentDialog, persistenceWarning } from './RemoteDevelopmentDialog';

function session(available: boolean, develop: boolean): Session {
	return {
		session_id: '01JSESSION',
		project_id: '01JPROJECT',
		notebook_id: '01JNOTEBOOK',
		user_id: '01JUSER',
		status: 'running',
		started_at: '2026-01-01T00:00:00Z',
		last_heartbeat: '2026-01-01T00:00:00Z',
		mode: 'edit',
		can: { attach: true, stop: true, develop },
		remote_development: {
			ssh: available ? { available: true } : { available: false, reason: 'disabled' },
		},
	};
}

describe('RemoteDevelopmentDialog', () => {
	it('is visible only for an eligible session and copies the exact command', async () => {
		const user = userEvent.setup();
		render(
			<RemoteDevelopmentDialog
				projectId="01JPROJECT"
				notebookId="01JNOTEBOOK"
				session={session(true, true)}
				persistence="workspace"
			/>,
		);
		await user.click(screen.getByText('Connect from VS Code'));
		expect(screen.getByLabelText('CLI command')).toHaveValue(
			'mohub sessions code --pid 01JPROJECT --nid 01JNOTEBOOK --sid 01JSESSION',
		);
		expect(screen.getByText(persistenceWarning('workspace'))).toBeInTheDocument();
	});

	it.each([
		[false, true],
		[true, false],
	] as const)('is hidden when available=%s and develop=%s', (available, develop) => {
		render(
			<RemoteDevelopmentDialog
				projectId="01JPROJECT"
				notebookId="01JNOTEBOOK"
				session={session(available, develop)}
				persistence="source"
			/>,
		);
		expect(screen.queryByText('Connect from VS Code')).not.toBeInTheDocument();
	});

	it('has distinct persistence warnings', () => {
		expect(
			new Set(['workspace', 'source', 'none'].map((mode) => persistenceWarning(mode as never)))
				.size,
		).toBe(3);
	});
});
