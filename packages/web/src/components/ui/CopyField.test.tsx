import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CopyField } from './CopyField';

/**
 * `userEvent.setup()` installs its own `navigator.clipboard`, so the component's
 * clipboard must be stubbed after it — otherwise the copy silently succeeds
 * against user-event's stub and the refusal case can't be exercised.
 */
function setupWithClipboard(writeText: () => Promise<void>) {
	const user = userEvent.setup();
	const spy = vi.fn(writeText);
	Object.defineProperty(navigator, 'clipboard', { value: { writeText: spy }, configurable: true });
	return { user, writeText: spy };
}

afterEach(() => {
	vi.restoreAllMocks();
	// restoreAllMocks does not revert a property descriptor, so the stub would
	// stay installed over the real Clipboard API for the rest of the run.
	Reflect.deleteProperty(navigator, 'clipboard');
});

describe('CopyField', () => {
	it('captions the value and names the input for assistive tech', () => {
		render(<CopyField label="Sync URL" value="https://hub.example/sync" />);
		expect(screen.getByText('Sync URL')).toBeInTheDocument();
		expect(screen.getByLabelText('Sync URL')).toHaveValue('https://hub.example/sync');
	});

	it('drops the caption but keeps the accessible name when hideLabel is set', () => {
		render(<CopyField label="API token" value="mhub_pat_abc" hideLabel />);
		expect(screen.queryByText('API token')).not.toBeInTheDocument();
		expect(screen.getByLabelText('API token')).toHaveValue('mhub_pat_abc');
	});

	it('derives the button label from the field label, unless overridden', () => {
		const { unmount } = render(<CopyField label="Sync token" value="t" />);
		expect(screen.getByRole('button', { name: 'Copy sync token' })).toBeInTheDocument();
		unmount();

		render(<CopyField label="API token" value="t" hideLabel copyLabel="Copy token" />);
		expect(screen.getByRole('button', { name: 'Copy token' })).toBeInTheDocument();
	});

	it('copies the value and acknowledges it on the button', async () => {
		const { user, writeText } = setupWithClipboard(() => Promise.resolve());
		render(<CopyField label="Sync URL" value="https://hub.example/sync" />);

		await user.click(screen.getByRole('button', { name: 'Copy sync url' }));

		expect(writeText).toHaveBeenCalledWith('https://hub.example/sync');
		await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument());
	});

	it('leaves the button unacknowledged when the clipboard write is refused', async () => {
		const { user } = setupWithClipboard(() => Promise.reject(new Error('denied')));
		render(<CopyField label="Sync URL" value="https://hub.example/sync" />);

		await user.click(screen.getByRole('button', { name: 'Copy sync url' }));

		await waitFor(() =>
			expect(screen.getByRole('button', { name: 'Copy sync url' })).toBeInTheDocument(),
		);
		expect(screen.queryByRole('button', { name: 'Copied' })).not.toBeInTheDocument();
	});

	it('is read-only — the value cannot be edited in place', async () => {
		const user = userEvent.setup();
		render(<CopyField label="Sync URL" value="https://hub.example/sync" />);
		const input = screen.getByLabelText('Sync URL');

		await user.type(input, 'tampered');

		expect(input).toHaveValue('https://hub.example/sync');
	});
});
