import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { fetchProbe } from './browseContract';

it('returns redirect responses without following their location', async () => {
	const requests: string[] = [];
	const server = createServer((request, response) => {
		requests.push(request.url!);
		response.writeHead(302, { location: '/redirect-target' });
		response.end(JSON.stringify({ message: 'Moved' }));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	try {
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('Expected a TCP address.');
		const response = await fetchProbe().fetch(`http://127.0.0.1:${address.port}/catalogs`);
		expect(response.ok).toBe(false);
		expect(response.status).toBe(302);
		expect(await response.json()).toEqual({ message: 'Moved' });
		expect(requests).toEqual(['/catalogs']);
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});
