import type { Role, SessionMode, ViewerMode } from '../../constants';
import { viewerSessionModes } from '../../constants';
import type { UserId } from '../../ids';
import type { Session } from '../../schema';
import { MODE_POLICY, sessionMode } from './sessionState';

/**
 * The caller as session authorization sees them: their effective role on the
 * project (`null` = none) and the deployment's viewer tier. Computed once per
 * request (via `effectiveRole`) and fed to every `sessionCan` decision.
 */
export interface SessionActor {
	userId: UserId;
	role: Role | null;
	viewerMode?: ViewerMode;
}

/**
 * `attach` — reach the session's kernel: proxy/WS traffic, keep-alive
 * heartbeats, and seeing `sandbox_url` (in `subdomain` exposure the URL is
 * the capability). `stop` — terminate or restart it.
 */
export type SessionAction = 'attach' | 'stop';

/**
 * May the actor START a session of `mode`? Editor+ always; a viewer exactly
 * when the deployment's viewer tier grants the mode (`VIEWER_SESSION_MODES`).
 */
export function canStartSessionMode(
	actor: Pick<SessionActor, 'role' | 'viewerMode'>,
	mode: SessionMode,
): boolean {
	if (actor.role === 'editor' || actor.role === 'admin') return true;
	return actor.role === 'viewer' && viewerSessionModes(actor.viewerMode).includes(mode);
}

/**
 * The one session-permission decision. Everything downstream — the API's
 * throwing gates, the `sandbox_url` projection, and the `can` grants shipped
 * on session responses — is this function applied to (actor, session), so the
 * answers cannot drift between surfaces.
 *
 * Editor+ may do everything. A viewer fully controls their OWN ephemeral
 * session (strict id equality — an email-invite match never transfers someone
 * else's session), and may `attach` to a shared-mode session their viewer
 * tier grants; `stop` of a shared session stays editor+ (a viewer must not
 * kill the app under everyone else). No role at all grants nothing, including
 * to a stale owner — a revoked membership cuts kernel access.
 */
export function sessionCan(
	action: SessionAction,
	actor: SessionActor,
	session: Pick<Session, 'mode' | 'ephemeral' | 'user_id'>,
): boolean {
	if (actor.role === 'editor' || actor.role === 'admin') return true;
	if (actor.role === null) return false;
	if (session.ephemeral && session.user_id === actor.userId) {
		// The owner may always stop their own throwaway; `attach` additionally
		// requires the tier to still grant the mode, so a VIEWER_MODE downgrade
		// cuts a live viewer kernel immediately instead of waiting out the session.
		return action === 'stop' || viewerSessionModes(actor.viewerMode).includes(sessionMode(session));
	}
	if (action === 'stop') return false;
	const mode = sessionMode(session);
	return (
		MODE_POLICY[mode].viewerSession === 'shared' &&
		viewerSessionModes(actor.viewerMode).includes(mode)
	);
}

/** Both grants at once — the `can` object shipped on every session response. */
export function sessionGrants(
	actor: SessionActor,
	session: Pick<Session, 'mode' | 'ephemeral' | 'user_id'>,
): { attach: boolean; stop: boolean } {
	return {
		attach: sessionCan('attach', actor, session),
		stop: sessionCan('stop', actor, session),
	};
}
