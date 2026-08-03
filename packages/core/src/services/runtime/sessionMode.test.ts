import { describe, expect, it } from 'vitest';
import { VIEWER_MODES, VIEWER_SESSION_MODES, viewerSessionModes } from '../../constants';
import { MODE_POLICY, sessionMode, sessionPersistsEdits } from './sessionState';

describe('sessionMode', () => {
	it('defaults an absent mode to edit (records predating the field)', () => {
		expect(sessionMode({})).toBe('edit');
		expect(sessionMode({ mode: undefined })).toBe('edit');
	});

	it('returns the stored mode', () => {
		expect(sessionMode({ mode: 'edit' })).toBe('edit');
		expect(sessionMode({ mode: 'app' })).toBe('app');
	});
});

describe('sessionPersistsEdits', () => {
	// The full {ephemeral} × {mode} matrix: only a non-ephemeral edit persists.
	it.each([
		{ ephemeral: undefined, mode: undefined, persists: true },
		{ ephemeral: undefined, mode: 'edit' as const, persists: true },
		{ ephemeral: undefined, mode: 'app' as const, persists: false },
		{ ephemeral: true, mode: undefined, persists: false },
		{ ephemeral: true, mode: 'edit' as const, persists: false },
		{ ephemeral: true, mode: 'app' as const, persists: false },
	])('ephemeral=$ephemeral mode=$mode → $persists', ({ ephemeral, mode, persists }) => {
		expect(sessionPersistsEdits({ ephemeral, mode })).toBe(persists);
	});
});

describe('VIEWER_SESSION_MODES', () => {
	it('each viewer mode is a superset of the previous (static ⊂ applications ⊂ ephemeral-sandbox)', () => {
		for (let i = 1; i < VIEWER_MODES.length; i++) {
			const prev = VIEWER_SESSION_MODES[VIEWER_MODES[i - 1]];
			const next = VIEWER_SESSION_MODES[VIEWER_MODES[i]];
			for (const mode of prev) expect(next).toContain(mode);
		}
	});

	it('grants apps at `applications` and up, edit kernels only at `ephemeral-sandbox`', () => {
		expect(VIEWER_SESSION_MODES.static).toEqual([]);
		expect(VIEWER_SESSION_MODES.applications).toEqual(['app']);
		expect([...VIEWER_SESSION_MODES['ephemeral-sandbox']].toSorted()).toEqual(['app', 'edit']);
	});

	it('viewerSessionModes fails closed to static for unset and out-of-enum values', () => {
		expect(viewerSessionModes(undefined)).toEqual([]);
		expect(viewerSessionModes('everything' as never)).toEqual([]);
		expect(viewerSessionModes('applications')).toEqual(['app']);
	});

	// Pinned: flipping either silently changes what viewers get — a non-ephemeral
	// viewer edit session would persist (and carry WIF/integration credentials); an ephemeral app
	// would fork the shared singleton per viewer.
	it('a viewer edit session is their own throwaway; a viewer app is the shared singleton', () => {
		expect(MODE_POLICY.edit.viewerSession).toBe('ephemeral');
		expect(MODE_POLICY.app.viewerSession).toBe('shared');
	});
});
