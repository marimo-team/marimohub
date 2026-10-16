import { expect, it, vi } from 'vitest';
import { UnavailableError, ValidationError } from '@marimo-hub/core/errors';
import { GitLabSourceControl } from './index';

const repository = 'https://gitlab.com/team/project';
it('classifies a malformed branch commit as provider unavailability', async () => {
	const fetcher = vi.fn(async () => Response.json({ name: 'main', commit: { id: 'invalid' } }));
	const adapter = new GitLabSourceControl({ token: 'token' }, { fetcher });
	await expect(adapter.getBranchHead(repository, 'main')).rejects.toBeInstanceOf(UnavailableError);
	expect(fetcher).toHaveBeenCalledOnce();
});
it('keeps a malformed user commit as a validation failure before making requests', async () => {
	const fetcher = vi.fn();
	const adapter = new GitLabSourceControl({ token: 'token' }, { fetcher });
	await expect(adapter.fetchWorkspace(repository, 'invalid', '')).rejects.toBeInstanceOf(
		ValidationError,
	);
	expect(fetcher).not.toHaveBeenCalled();
});
