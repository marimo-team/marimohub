import { describe, expect, it } from 'vitest';
import type { UserId } from '../../ids';
import type { SessionActor } from './sessionAuthz';
import { canStartSessionMode, sessionCan, sessionGrants } from './sessionAuthz';

const ME = 'user_me' as UserId;
const OTHER = 'user_other' as UserId;

const actor = (over: Partial<SessionActor>): SessionActor => ({
	userId: ME,
	role: 'viewer',
	viewerMode: 'static',
	...over,
});

const ownEphemeral = { mode: undefined, ephemeral: true, user_id: ME };
const otherEdit = { mode: 'edit' as const, ephemeral: undefined, user_id: OTHER };
const otherEphemeral = { mode: 'edit' as const, ephemeral: true, user_id: OTHER };
const app = { mode: 'app' as const, ephemeral: undefined, user_id: OTHER };

describe('canStartSessionMode', () => {
	it('editor+ starts any mode regardless of viewer tier', () => {
		expect(canStartSessionMode({ role: 'editor', viewerMode: 'static' }, 'app')).toBe(true);
		expect(canStartSessionMode({ role: 'manager', viewerMode: undefined }, 'edit')).toBe(true);
		expect(canStartSessionMode({ role: 'admin', viewerMode: undefined }, 'edit')).toBe(true);
	});

	it('a viewer starts exactly what the tier grants', () => {
		expect(canStartSessionMode(actor({ viewerMode: 'static' }), 'app')).toBe(false);
		expect(canStartSessionMode(actor({ viewerMode: 'applications' }), 'app')).toBe(true);
		expect(canStartSessionMode(actor({ viewerMode: 'applications' }), 'edit')).toBe(false);
		expect(canStartSessionMode(actor({ viewerMode: 'ephemeral-sandbox' }), 'edit')).toBe(true);
		expect(canStartSessionMode(actor({ viewerMode: 'ephemeral-sandbox' }), 'app')).toBe(true);
	});

	it('no role starts nothing, whatever the tier', () => {
		expect(canStartSessionMode({ role: null, viewerMode: 'ephemeral-sandbox' }, 'edit')).toBe(
			false,
		);
	});
});

describe('sessionCan', () => {
	it('editor+ may attach to and stop everything', () => {
		for (const s of [ownEphemeral, otherEdit, otherEphemeral, app]) {
			expect(sessionCan('attach', actor({ role: 'editor' }), s)).toBe(true);
			expect(sessionCan('stop', actor({ role: 'admin' }), s)).toBe(true);
		}
	});

	it('keeps exclusive editor kernels private while allowing manager shutdown', () => {
		const exclusive = { ...otherEdit, editor_sandbox_sharing: 'exclusive' as const };
		expect(sessionCan('attach', actor({ role: 'editor' }), exclusive)).toBe(false);
		expect(sessionCan('stop', actor({ role: 'editor' }), exclusive)).toBe(false);
		expect(sessionCan('attach', actor({ role: 'manager' }), exclusive)).toBe(false);
		expect(sessionCan('stop', actor({ role: 'manager' }), exclusive)).toBe(true);
		expect(sessionCan('attach', actor({ role: 'admin' }), exclusive)).toBe(false);
		expect(sessionCan('stop', actor({ role: 'admin' }), exclusive)).toBe(true);
	});

	it('allows surfaces only for editors who may attach to edit sessions', () => {
		expect(sessionCan('surface', actor({ role: 'editor' }), otherEdit)).toBe(true);
		expect(
			sessionCan(
				'surface',
				actor({ role: 'viewer', viewerMode: 'ephemeral-sandbox' }),
				ownEphemeral,
			),
		).toBe(false);
		expect(sessionCan('surface', actor({ role: 'admin' }), app)).toBe(false);
		expect(
			sessionCan('surface', actor({ role: 'manager' }), {
				...otherEdit,
				editor_sandbox_sharing: 'exclusive',
			}),
		).toBe(false);
	});

	it('a viewer fully controls their own ephemeral session while the tier grants it', () => {
		expect(sessionCan('attach', actor({ viewerMode: 'ephemeral-sandbox' }), ownEphemeral)).toBe(
			true,
		);
		expect(sessionCan('stop', actor({ viewerMode: 'ephemeral-sandbox' }), ownEphemeral)).toBe(true);
	});

	it('a VIEWER_MODE downgrade cuts attach to an existing ephemeral session; stop stays', () => {
		expect(sessionCan('attach', actor({ viewerMode: 'static' }), ownEphemeral)).toBe(false);
		expect(sessionCan('attach', actor({ viewerMode: 'applications' }), ownEphemeral)).toBe(false);
		expect(sessionCan('stop', actor({ viewerMode: 'static' }), ownEphemeral)).toBe(true);
		expect(sessionCan('stop', actor({ viewerMode: 'applications' }), ownEphemeral)).toBe(true);
	});

	it('ownership never transfers: another viewer gets nothing on an ephemeral session', () => {
		expect(sessionCan('attach', actor({ viewerMode: 'ephemeral-sandbox' }), otherEphemeral)).toBe(
			false,
		);
		expect(sessionCan('stop', actor({ viewerMode: 'ephemeral-sandbox' }), otherEphemeral)).toBe(
			false,
		);
	});

	it('a viewer attaches to the shared app exactly when the tier grants apps — and never stops it', () => {
		expect(sessionCan('attach', actor({ viewerMode: 'static' }), app)).toBe(false);
		expect(sessionCan('attach', actor({ viewerMode: 'applications' }), app)).toBe(true);
		expect(sessionCan('attach', actor({ viewerMode: 'ephemeral-sandbox' }), app)).toBe(true);
		expect(sessionCan('stop', actor({ viewerMode: 'applications' }), app)).toBe(false);
		expect(sessionCan('stop', actor({ viewerMode: 'ephemeral-sandbox' }), app)).toBe(false);
	});

	it("a viewer never reaches another user's edit kernel", () => {
		expect(sessionCan('attach', actor({ viewerMode: 'ephemeral-sandbox' }), otherEdit)).toBe(false);
	});

	it('no role grants nothing — even to a stale ephemeral owner (revoked membership)', () => {
		expect(sessionCan('attach', actor({ role: null }), ownEphemeral)).toBe(false);
		expect(sessionCan('stop', actor({ role: null }), ownEphemeral)).toBe(false);
		expect(sessionCan('attach', actor({ role: null, viewerMode: 'applications' }), app)).toBe(
			false,
		);
	});
});

describe('sessionGrants', () => {
	it('bundles both decisions', () => {
		expect(sessionGrants(actor({ viewerMode: 'applications' }), app)).toEqual({
			attach: true,
			stop: false,
			surface: false,
		});
		expect(sessionGrants(actor({ role: 'editor' }), app)).toEqual({
			attach: true,
			stop: true,
			surface: false,
		});
	});
});
