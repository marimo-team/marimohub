import { toast } from 'sonner';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installMatchMedia, renderWithClient, setupUser } from '@/test/render';
import { PreviewActionSetup } from './PreviewActionSetup';

beforeEach(() => installMatchMedia());
afterEach(() => vi.restoreAllMocks());

describe('GitHub Action setup', () => {
	it('copies a configured workflow without including a token', async () => {
		const user = setupUser();
		const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
		renderWithClient(<PreviewActionSetup pid="proj" nid="nb" />);
		await user.click(screen.getByRole('button', { name: 'Set up GitHub Action' }));
		await user.selectOptions(screen.getByRole('combobox', { name: 'Preview mode' }), 'commits');
		await user.clear(screen.getByLabelText('Commits to keep'));
		await user.type(screen.getByLabelText('Commits to keep'), '3');
		await user.click(screen.getByLabelText('Prepare code automatically'));
		await user.type(screen.getByLabelText('Expire after inactive days (optional)'), '2');
		await user.click(screen.getByRole('button', { name: 'Copy workflow' }));
		expect(copy).toHaveBeenCalledWith(expect.stringContaining("project-id: 'proj'"));
		expect(copy).toHaveBeenCalledWith(expect.stringContaining("notebook-id: 'nb'"));
		expect(copy).toHaveBeenCalledWith(expect.stringContaining('secrets.MARIMOHUB_TOKEN'));
		expect(copy).toHaveBeenCalledWith(expect.stringContaining("eager: 'false'"));
		expect(copy).toHaveBeenCalledWith(expect.stringContaining("keep: '3'"));
		expect(copy).toHaveBeenCalledWith(expect.stringContaining("idle-days: '2'"));
	});

	it('includes the deployment prefix in the copied Hub URL', async () => {
		const base = document.createElement('base');
		base.href = '/nested/hub/';
		document.head.append(base);
		try {
			const user = setupUser();
			const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
			renderWithClient(<PreviewActionSetup pid="proj" nid="nb" />);
			await user.click(screen.getByRole('button', { name: 'Set up GitHub Action' }));
			await user.click(screen.getByRole('button', { name: 'Copy workflow' }));
			expect(copy).toHaveBeenCalledWith(
				expect.stringContaining(`hub-url: '${window.location.origin}/nested/hub'`),
			);
		} finally {
			base.remove();
		}
	});

	it('validates retention only in commit mode', async () => {
		const user = setupUser();
		renderWithClient(<PreviewActionSetup pid="proj" nid="nb" />);
		await user.click(screen.getByRole('button', { name: 'Set up GitHub Action' }));
		await user.selectOptions(screen.getByRole('combobox', { name: 'Preview mode' }), 'commits');
		await user.clear(screen.getByLabelText('Commits to keep'));
		await user.type(screen.getByLabelText('Commits to keep'), '26');
		expect(screen.getByRole('button', { name: 'Copy workflow' })).toBeDisabled();
		expect(screen.getByLabelText('GitHub Actions workflow')).toBeEmptyDOMElement();
		await user.selectOptions(screen.getByRole('combobox', { name: 'Preview mode' }), 'sticky');
		expect(screen.getByRole('button', { name: 'Copy workflow' })).toBeEnabled();
		expect(screen.getByLabelText('GitHub Actions workflow')).toHaveTextContent("keep: '5'");
	});
	it('reports clipboard failures without claiming the workflow was copied', async () => {
		const user = setupUser();
		vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Clipboard denied'));
		const error = vi.spyOn(toast, 'error');
		const success = vi.spyOn(toast, 'success');
		renderWithClient(<PreviewActionSetup pid="proj" nid="nb" />);
		await user.click(screen.getByRole('button', { name: 'Set up GitHub Action' }));
		await user.click(screen.getByRole('button', { name: 'Copy workflow' }));
		await waitFor(() => expect(error).toHaveBeenCalledWith('Could not copy to clipboard'));
		expect(success).not.toHaveBeenCalled();
	});

	it.each(['0', '31', '1.5'])(
		'prevents copying an invalid inactivity timeout: %s',
		async (value) => {
			const user = setupUser();
			renderWithClient(<PreviewActionSetup pid="proj" nid="nb" />);
			await user.click(screen.getByRole('button', { name: 'Set up GitHub Action' }));
			await user.type(screen.getByLabelText('Expire after inactive days (optional)'), value);
			expect(screen.getByRole('button', { name: 'Copy workflow' })).toBeDisabled();
		},
	);
});
