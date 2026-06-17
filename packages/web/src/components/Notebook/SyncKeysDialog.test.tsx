import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toaster } from 'sonner';
import { SyncKeysDialog } from './SyncKeysDialog';

const SYNC_URL = 'https://host/api/sync/git/v1/projects/proj-x/notebooks/nb-9';

function renderDialog(props: { token?: string }) {
	const onClose = vi.fn();
	render(
		<>
			<SyncKeysDialog
				isOpen
				onClose={onClose}
				title="Dash"
				syncUrl={SYNC_URL}
				token={props.token}
			/>
			<Toaster />
		</>,
	);
	return { onClose };
}

describe('SyncKeysDialog', () => {
	it('always shows the sync URL', () => {
		renderDialog({});
		expect(screen.getByDisplayValue(SYNC_URL)).toBeInTheDocument();
	});

	it('reveals the token with a one-time warning when present', () => {
		renderDialog({ token: 'mhsync_secret' });
		expect(screen.getByDisplayValue('mhsync_secret')).toBeInTheDocument();
		expect(screen.getByText(/shown once/i)).toBeInTheDocument();
	});

	it('explains how to obtain a token when none is present', () => {
		renderDialog({});
		expect(screen.queryByDisplayValue('mhsync_secret')).not.toBeInTheDocument();
		expect(screen.getByText(/rotate the token to mint a new one/i)).toBeInTheDocument();
	});

	it('copies a field to the clipboard', async () => {
		const user = userEvent.setup();
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
		renderDialog({});

		await user.click(screen.getByRole('button', { name: /copy sync url/i }));

		expect(writeText).toHaveBeenCalledWith(SYNC_URL);
	});
});
