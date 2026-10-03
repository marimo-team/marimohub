import { describe, expect, it } from 'vitest';
import { createNotebookId, createVersionId } from './ids';
import { makeSession } from './testing/fixtures';
import { sessionResourceNotebookId, sessionResourcePath } from './sessionOrigin';

describe('session resource identity', () => {
	it('keeps ordinary and legacy notebook sessions unchanged', () => {
		const session = makeSession();
		expect(sessionResourceNotebookId(session)).toBe(session.notebook_id);
		expect(sessionResourcePath(session)).toBe(
			`/projects/${session.project_id}/notebooks/${session.notebook_id}`,
		);
	});
	it('resolves a preview resource from durable provenance alone', () => {
		const origin = {
			type: 'preview' as const,
			notebook_id: createNotebookId(),
			preview_id: 'a'.repeat(32),
			revision_id: createVersionId(),
			commit: 'b'.repeat(40),
		};
		const session = makeSession({ origin });
		expect(sessionResourceNotebookId(session)).toBe(origin.notebook_id);
		expect(sessionResourcePath(session)).toBe(
			`/projects/${session.project_id}/notebooks/${origin.notebook_id}/previews/${origin.preview_id}`,
		);
		expect(sessionResourcePath(session)).not.toContain(session.notebook_id);
	});
});
