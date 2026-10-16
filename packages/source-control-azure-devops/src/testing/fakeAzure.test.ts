import { describe, expect, it } from 'vitest';
import { FakeAzure } from './fakeAzure';

const api = 'https://dev.azure.com/acme/Project%20One/_apis/git/repositories/notebooks';

describe('FakeAzure HTTP methods', () => {
	it.each([
		['/commits/object', ['POST', 'PUT', 'PATCH', 'DELETE']],
		['/trees/object', ['POST', 'PUT', 'PATCH', 'DELETE']],
		['/blobs/object', ['POST', 'PUT', 'PATCH', 'DELETE']],
		['/pushes', ['GET', 'PUT', 'PATCH', 'DELETE']],
		['/pullrequests/1', ['POST', 'PUT', 'DELETE']],
	] as const)('rejects unsupported methods for %s', async (path, methods) => {
		const fake = new FakeAzure();
		fake.pulls.push({
			pullRequestId: 1,
			sourceRefName: 'refs/heads/proposal',
			targetRefName: 'refs/heads/main',
			status: 'active',
			title: 'Original title',
			description: '',
			isDraft: false,
		});
		for (const method of methods) {
			await expect(
				fake.fetcher(`${api}${path}?api-version=7.1`, {
					method,
					body: JSON.stringify({ title: 'Incorrect mutation' }),
				}),
			).rejects.toThrow(`Unexpected request ${method} ${path}`);
		}
		expect(fake.pulls[0].title).toBe('Original title');
		expect(fake.refs).toEqual(new Map([['refs/heads/main', fake.base]]));
		expect(fake.commits.size).toBe(1);
	});
});
