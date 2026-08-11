import type { AuthUser } from './ports/auth';
import type {
	Identity,
	Notification,
	NotificationRecipient,
	Project,
	ProjectMember,
} from './schema';
import { NotificationRecipientSchema } from './schema';

export const SYNC_NOTIFICATION_KINDS = [
	'member.invited',
	'member.added',
	'session.takeover',
] as const;

export type SyncNotificationKind = (typeof SYNC_NOTIFICATION_KINDS)[number];

function hubLink(baseUrl: string | undefined, path: string): string | undefined {
	if (!baseUrl) return undefined;
	return new URL(path, baseUrl).toString();
}

export function recipientFromIdentity(
	identity: Identity | null | undefined,
): NotificationRecipient | null {
	if (!identity) return null;
	const name = identity.name.trim();
	const result = NotificationRecipientSchema.safeParse({
		userId: identity.id,
		email: identity.email,
		...(name ? { name } : {}),
	});
	return result.success ? result.data : null;
}

export function resolveMemberRecipient(
	member: ProjectMember,
	identity?: Identity | null,
): NotificationRecipient | null {
	if (member.email) return { email: member.email };
	return recipientFromIdentity(identity);
}

export interface MemberNotificationInput {
	project: Project;
	member: ProjectMember;
	recipient: NotificationRecipient | null;
	actor: AuthUser;
	mutationId: string;
	baseUrl?: string;
}

export interface SessionTakeoverNotificationInput {
	project: Project;
	notebookTitle: string;
	projectId: string;
	notebookId: string;
	takeoverId: string;
	recipient: NotificationRecipient | null;
	actor: AuthUser;
	baseUrl?: string;
}

export type NotificationRenderInput =
	| ({ kind: 'member.invited' | 'member.added' } & MemberNotificationInput)
	| ({ kind: 'session.takeover' } & SessionTakeoverNotificationInput);

function actorLabel(actor: AuthUser): string {
	return actor.name?.trim() || actor.email;
}

export function renderMemberNotification(
	input: MemberNotificationInput,
	kind: 'member.invited' | 'member.added',
): Notification {
	const action = kind === 'member.invited' ? 'invited' : 'added';
	const notification: Notification = {
		kind,
		severity: 'info',
		title: `You were ${action} to ${input.project.name}`,
		body: `${actorLabel(input.actor)} ${action} you to ${input.project.name} as ${input.member.role}.`,
		recipients: input.recipient ? [input.recipient] : [],
		context: { pid: input.project.id, role: input.member.role },
		dedupe_key: `${kind}:${input.mutationId}`,
	};
	const link = hubLink(input.baseUrl, `/projects/${encodeURIComponent(input.project.id)}`);
	return link ? { ...notification, link } : notification;
}

export function renderSessionTakeoverNotification(
	input: SessionTakeoverNotificationInput,
): Notification {
	const notification: Notification = {
		kind: 'session.takeover',
		severity: 'warning',
		title: 'Your editor session was taken over',
		body: `${actorLabel(input.actor)} took over ${input.notebookTitle} in ${input.project.name}.`,
		recipients: input.recipient ? [input.recipient] : [],
		context: {
			pid: input.projectId,
			nid: input.notebookId,
			takeover_id: input.takeoverId,
		},
		dedupe_key: `session.takeover:${input.takeoverId}`,
	};
	const link = hubLink(
		input.baseUrl,
		`/projects/${encodeURIComponent(input.projectId)}/notebooks/${encodeURIComponent(input.notebookId)}`,
	);
	return link ? { ...notification, link } : notification;
}

export class NotificationRouter {
	render(input: NotificationRenderInput): Notification {
		switch (input.kind) {
			case 'member.invited':
			case 'member.added':
				return renderMemberNotification(input, input.kind);
			case 'session.takeover':
				return renderSessionTakeoverNotification(input);
		}
	}
}

export const notificationRouter = new NotificationRouter();
