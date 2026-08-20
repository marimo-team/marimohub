import { describe, expect, it } from 'vitest';
import { listFilesFailure } from '../ports/sandbox';
import { makeFsSandbox } from './fakes';

describe('makeFsSandbox', () => {
	it('returns NOT_A_DIRECTORY when listFiles receives a file path', async () => {
		const { instance } = makeFsSandbox({ files: { 'notebook.py': 'print(1)' } });

		await expect(instance.listFiles('/workspace/notebook.py')).resolves.toEqual(
			listFilesFailure('NOT_A_DIRECTORY'),
		);
	});
});
