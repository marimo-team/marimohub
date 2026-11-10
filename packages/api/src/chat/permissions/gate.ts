import {
	ChatPermissionStore,
	ConversationPermissionSchema,
	ConversationService,
} from '@marimo-hub/core/chat';
import type { ConversationPermission, PermissionStatus } from '@marimo-hub/core/chat';
import type { AuthenticatedPrincipal, Project } from '@marimo-hub/core';
import type { ApiDeps } from '../../context';
import { DEFAULT_CHAT_CONFIG } from '../../context';
import { assertChatPrincipalCurrent } from '../access';
import { permissionBroker, permissionKey } from './broker';
import { permissionRequest } from './policies';
import type { GatedTool } from './policies';

export interface GateContext {
	deps: ApiDeps;
	principal: AuthenticatedPrincipal;
	project: Project;
	conversationId: string;
	toolCallId: string;
	/** Only interactive (streaming) turns can show a card and wait for an answer. */
	canPrompt: boolean;
	tool: GatedTool;
	/** Publish the card's current state into the transcript. */
	record(permission: ConversationPermission): Promise<unknown>;
	signal?: AbortSignal;
}

export type GateDecision =
	| { allowed: true }
	| {
			allowed: false;
			status: Exclude<PermissionStatus, 'open' | 'allowed' | 'remembered'>;
			message: string;
	  };

const MESSAGES = {
	denied: 'The user did not allow this action.',
	expired: 'No answer in time. The action did not run.',
	unavailable: 'This client cannot ask for permission. The action did not run.',
	cancelled: 'The turn was stopped before a decision.',
} as const;

/**
 * Consent gate for one tool call. Remembered grants pass silently; otherwise a
 * card is published and the turn waits for the user, from any replica, until
 * the configured timeout.
 */
export async function checkPermission(
	ctx: GateContext,
	input: Record<string, unknown>,
): Promise<GateDecision> {
	const consentInput = ctx.tool.consentInput ? await ctx.tool.consentInput(input) : input;
	const request = permissionRequest(ctx.tool, consentInput);
	if (!request) return { allowed: true };
	const timeoutMs =
		(ctx.deps.ai?.chat?.permissionTimeoutSeconds ?? DEFAULT_CHAT_CONFIG.permissionTimeoutSeconds) *
		1000;
	let permission = ConversationPermissionSchema.parse({
		...request,
		id: crypto.randomUUID(),
		tool_call_id: ctx.toolCallId,
		status: 'open',
		expires_at: new Date(Date.now() + timeoutMs).toISOString(),
	});
	const store = new ChatPermissionStore(ctx.deps.bucket);
	if (
		request.can_remember &&
		(await store.find(ctx.project.id, ctx.principal.id, request.kind, request.scope.key))
	) {
		await ctx.record({ ...permission, status: 'remembered' });
		return { allowed: true };
	}
	if (!ctx.canPrompt) {
		await ctx.record({ ...permission, status: 'unavailable' });
		return { allowed: false, status: 'unavailable', message: MESSAGES.unavailable };
	}
	const key = permissionKey(ctx.project.id, ctx.conversationId, permission.id);
	const controller = new AbortController();
	const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
	const conversations = new ConversationService(ctx.deps.bucket);
	// Register before publishing the card so a fast decision cannot miss its waiter.
	const pending = permissionBroker.wait(key, {
		timeoutMs,
		signal,
		readDecision: () =>
			conversations.permissionDecision(
				ctx.project.id,
				ctx.principal.id,
				ctx.conversationId,
				permission.id,
			),
	});
	try {
		await ctx.record(permission);
		const decision = await pending;
		if (decision === 'allow' || decision === 'always') {
			await assertChatPrincipalCurrent(ctx.deps, ctx.principal, ctx.signal);
			const remember = decision === 'always' && request.can_remember;
			if (remember)
				await store.grant(ctx.project.id, ctx.principal.id, {
					kind: request.kind,
					scope_key: request.scope.key,
					scope_label: request.scope.label,
					action: request.action,
				});
			permission = { ...permission, status: remember ? 'remembered' : 'allowed' };
			await ctx.record(permission);
			return { allowed: true };
		}
		const status = decision === 'deny' ? 'denied' : decision;
		await ctx.record({ ...permission, status });
		return { allowed: false, status, message: MESSAGES[status] };
	} catch (error) {
		// The turn is failing; leave no card open in the transcript.
		await ctx.record({ ...permission, status: 'cancelled' }).catch(() => {});
		throw error;
	} finally {
		controller.abort();
	}
}
