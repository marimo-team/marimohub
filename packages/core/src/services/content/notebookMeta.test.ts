import { describe, expect, it } from 'vitest';
import { createVersionId } from '../../ids';
import { localSource } from './notebookMeta';

describe('localSource', () => {
	it.each([
		'../escape.py',
		'/absolute.py',
		'a/../file.py',
		'a\\file.py',
		'',
		'.marimohub-directory/file.py',
		'file.py/child.txt',
		' report.py ',
	])('rejects invalid entrypoints at construction: %s', (path) =>
		expect(() => localSource(createVersionId(), path)).toThrow(),
	);

	it.each([' report.py', ' reports / report.py', 'notebook.py'])(
		'preserves the exact supported path: %s',
		(path) => expect(localSource(createVersionId(), path)).toMatchObject({ entry_notebook: path }),
	);

	it('keeps the legacy default implicit', () => {
		expect(localSource(createVersionId())).not.toHaveProperty('entry_notebook');
	});
});
