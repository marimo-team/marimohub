import { z } from 'zod';
import { ROLES } from './constants';
import type { AlertDestinationId, NotebookId, ProjectId, SessionId, UserId } from './ids';
import type { AuthUser } from './ports/auth';
import { EmailAddressSchema, NotebookIdSchema, ProjectIdSchema, UserIdSchema } from './schema';
import type { Identity, Project, ProjectMember } from './schema';

export const NotificationRecipientSchema = z.object({
	userId: UserIdSchema.optional(),
	email: EmailAddressSchema,
	name: z.string().min(1).optional(),
});

export type NotificationRecipient = z.infer<typeof NotificationRecipientSchema>;

export const NotificationAudienceSchema = z.enum(['personal', 'broadcast']);
export type NotificationAudience = z.infer<typeof NotificationAudienceSchema>;

const ProjectAlertDataSchema = z.object({
	project_id: ProjectIdSchema,
	project_name: z.string().min(1),
});

const NotebookAlertDataSchema = ProjectAlertDataSchema.extend({
	notebook_id: NotebookIdSchema,
	notebook_title: z.string().min(1),
});

const MemberInvitedDataSchema = ProjectAlertDataSchema.extend({
	role: z.enum(ROLES),
	member_email: EmailAddressSchema,
	actor_user_id: UserIdSchema,
});

const MemberAddedDataSchema = ProjectAlertDataSchema.extend({
	role: z.enum(ROLES),
	member_user_id: UserIdSchema,
	actor_user_id: UserIdSchema,
});

const SessionTakeoverDataSchema = NotebookAlertDataSchema.extend({
	takeover_id: z.string().min(1),
	actor_user_id: UserIdSchema,
	displaced_user_id: UserIdSchema,
});

const MemberRoleChangedDataSchema = ProjectAlertDataSchema.extend({
	member_user_id: UserIdSchema.nullable(),
	member_email: EmailAddressSchema.nullable(),
	old_role: z.enum(ROLES),
	new_role: z.enum(ROLES),
	actor_user_id: UserIdSchema,
});

const MemberRemovedDataSchema = ProjectAlertDataSchema.extend({
	member_user_id: UserIdSchema.nullable(),
	member_email: EmailAddressSchema.nullable(),
	role: z.enum(ROLES),
	actor_user_id: UserIdSchema,
});

const NotebookDeletedDataSchema = NotebookAlertDataSchema.extend({
	actor_user_id: UserIdSchema,
});

const ProjectDeletedDataSchema = ProjectAlertDataSchema.extend({
	actor_user_id: UserIdSchema,
});

const AppFailureDataSchema = NotebookAlertDataSchema.extend({
	session_id: z.string().min(1),
	started_by_user_id: UserIdSchema,
	error_code: z.string().min(1),
});

const SyncFailedDataSchema = NotebookAlertDataSchema.extend({
	commit: z.string().min(1),
	error_code: z.string().min(1),
});

const AlertTestDataSchema = ProjectAlertDataSchema.extend({
	destination_id: z.string().min(1),
	actor_user_id: UserIdSchema,
	test_id: z.string().min(1),
});

interface NotificationContent<TData> {
	title: string;
	body: string;
	link?: string;
	recipients: NotificationRecipient[];
	context: Record<string, string>;
	data: TData;
	dedupeKey: string;
}

export interface MemberInvitedNotificationInput {
	project: Project;
	member: ProjectMember & { email: string };
	recipient: NotificationRecipient | null;
	actor: AuthUser;
	mutationId: string;
	baseUrl?: string;
}

export interface MemberAddedNotificationInput {
	project: Project;
	member: ProjectMember & { user_id: UserId };
	recipient: NotificationRecipient | null;
	actor: AuthUser;
	mutationId: string;
	baseUrl?: string;
}

export interface SessionTakeoverNotificationInput {
	project: Project;
	notebookTitle: string;
	projectId: ProjectId;
	notebookId: NotebookId;
	takeoverId: string;
	displacedUserId: UserId;
	recipient: NotificationRecipient | null;
	actor: AuthUser;
	baseUrl?: string;
}

export interface MemberRoleChangedNotificationInput {
	project: Project;
	member: ProjectMember;
	oldRole: ProjectMember['role'];
	actor: AuthUser;
	mutationId: string;
	baseUrl?: string;
}

export interface MemberRemovedNotificationInput {
	project: Project;
	member: ProjectMember;
	actor: AuthUser;
	mutationId: string;
	baseUrl?: string;
}

export interface NotebookDeletedNotificationInput {
	project: Project;
	notebookId: NotebookId;
	notebookTitle: string;
	actor: AuthUser;
	mutationId: string;
	baseUrl?: string;
}

export interface ProjectDeletedNotificationInput {
	project: Project;
	actor: AuthUser;
	mutationId: string;
}

export interface AppFailureNotificationInput {
	project: Project;
	notebookId: NotebookId;
	notebookTitle: string;
	sessionId: SessionId;
	startedByUserId: UserId;
	errorCode: string;
	baseUrl?: string;
}

export interface SyncFailedNotificationInput {
	project: Project;
	notebookId: NotebookId;
	notebookTitle: string;
	commit: string;
	errorCode: string;
	baseUrl?: string;
}

export interface AlertTestNotificationInput {
	project: Project;
	destinationId: AlertDestinationId;
	actor: AuthUser;
	testId: string;
}

function hubLink(baseUrl: string | undefined, path: string): string | undefined {
	if (!baseUrl) return undefined;
	return new URL(path, baseUrl).toString();
}

function optionalLink(link: string | undefined): { link?: string } {
	return link ? { link } : {};
}

function actorLabel(actor: AuthUser): string {
	return actor.name?.trim() || actor.email;
}

function recipientLabel(input: SessionTakeoverNotificationInput): string {
	return input.recipient?.name ?? input.recipient?.email ?? 'another editor';
}

function projectLink(projectId: ProjectId, baseUrl: string | undefined) {
	return hubLink(baseUrl, `/projects/${encodeURIComponent(projectId)}`);
}

function notebookLink(projectId: ProjectId, notebookId: NotebookId, baseUrl: string | undefined) {
	return hubLink(
		baseUrl,
		`/projects/${encodeURIComponent(projectId)}/notebooks/${encodeURIComponent(notebookId)}`,
	);
}

function memberLabel(member: ProjectMember): string {
	return member.email ?? member.user_id ?? 'project member';
}

function memberData(member: ProjectMember) {
	return {
		member_user_id: member.user_id ?? null,
		member_email: member.email ?? null,
	};
}

function projectData(project: Project, projectId: ProjectId = project.id) {
	return { project_id: projectId, project_name: project.name };
}

function notebookData(input: { project: Project; notebookId: NotebookId; notebookTitle: string }) {
	return {
		...projectData(input.project),
		notebook_id: input.notebookId,
		notebook_title: input.notebookTitle,
	};
}

function appFailureContent(
	input: AppFailureNotificationInput,
	kind: 'app.start_failed' | 'app.unavailable',
	title: string,
	body: string,
): NotificationContent<z.infer<typeof AppFailureDataSchema>> {
	return {
		title,
		body,
		...optionalLink(notebookLink(input.project.id, input.notebookId, input.baseUrl)),
		recipients: [],
		context: { pid: input.project.id, nid: input.notebookId, sid: input.sessionId },
		data: {
			...notebookData(input),
			session_id: input.sessionId,
			started_by_user_id: input.startedByUserId,
			error_code: input.errorCode,
		},
		dedupeKey: `${kind}:${input.sessionId}:broadcast`,
	};
}

export const NOTIFICATION_KIND_REGISTRY = {
	'member.invited': {
		severity: 'info',
		dataSchema: MemberInvitedDataSchema,
		render: {
			personal: (
				input: MemberInvitedNotificationInput,
			): NotificationContent<z.infer<typeof MemberInvitedDataSchema>> => ({
				title: `You were invited to ${input.project.name}`,
				body: `${actorLabel(input.actor)} invited you to ${input.project.name} as ${input.member.role}.`,
				...optionalLink(projectLink(input.project.id, input.baseUrl)),
				recipients: input.recipient ? [input.recipient] : [],
				context: { pid: input.project.id, role: input.member.role },
				data: {
					...projectData(input.project),
					role: input.member.role,
					member_email: input.member.email,
					actor_user_id: input.actor.id,
				},
				dedupeKey: `member.invited:${input.mutationId}:personal`,
			}),
			broadcast: (
				input: MemberInvitedNotificationInput,
			): NotificationContent<z.infer<typeof MemberInvitedDataSchema>> => ({
				title: `Member invited to ${input.project.name}`,
				body: `${actorLabel(input.actor)} invited ${input.member.email} to ${input.project.name} as ${input.member.role}.`,
				...optionalLink(projectLink(input.project.id, input.baseUrl)),
				recipients: [],
				context: { pid: input.project.id, role: input.member.role },
				data: {
					...projectData(input.project),
					role: input.member.role,
					member_email: input.member.email,
					actor_user_id: input.actor.id,
				},
				dedupeKey: `member.invited:${input.mutationId}:broadcast`,
			}),
		},
	},
	'member.added': {
		severity: 'info',
		dataSchema: MemberAddedDataSchema,
		render: {
			personal: (
				input: MemberAddedNotificationInput,
			): NotificationContent<z.infer<typeof MemberAddedDataSchema>> => ({
				title: `You were added to ${input.project.name}`,
				body: `${actorLabel(input.actor)} added you to ${input.project.name} as ${input.member.role}.`,
				...optionalLink(projectLink(input.project.id, input.baseUrl)),
				recipients: input.recipient ? [input.recipient] : [],
				context: { pid: input.project.id, role: input.member.role },
				data: {
					...projectData(input.project),
					role: input.member.role,
					member_user_id: input.member.user_id,
					actor_user_id: input.actor.id,
				},
				dedupeKey: `member.added:${input.mutationId}:personal`,
			}),
			broadcast: (
				input: MemberAddedNotificationInput,
			): NotificationContent<z.infer<typeof MemberAddedDataSchema>> => ({
				title: `Member added to ${input.project.name}`,
				body: `${actorLabel(input.actor)} added ${input.recipient?.name ?? input.recipient?.email ?? input.member.user_id} to ${input.project.name} as ${input.member.role}.`,
				...optionalLink(projectLink(input.project.id, input.baseUrl)),
				recipients: [],
				context: { pid: input.project.id, role: input.member.role },
				data: {
					...projectData(input.project),
					role: input.member.role,
					member_user_id: input.member.user_id,
					actor_user_id: input.actor.id,
				},
				dedupeKey: `member.added:${input.mutationId}:broadcast`,
			}),
		},
	},
	'session.takeover': {
		severity: 'warning',
		dataSchema: SessionTakeoverDataSchema,
		render: {
			personal: (
				input: SessionTakeoverNotificationInput,
			): NotificationContent<z.infer<typeof SessionTakeoverDataSchema>> => ({
				title: 'Your editor session was taken over',
				body: `${actorLabel(input.actor)} took over ${input.notebookTitle} in ${input.project.name}.`,
				...optionalLink(notebookLink(input.projectId, input.notebookId, input.baseUrl)),
				recipients: input.recipient ? [input.recipient] : [],
				context: {
					pid: input.projectId,
					nid: input.notebookId,
					takeover_id: input.takeoverId,
				},
				data: {
					...projectData(input.project, input.projectId),
					notebook_id: input.notebookId,
					notebook_title: input.notebookTitle,
					takeover_id: input.takeoverId,
					actor_user_id: input.actor.id,
					displaced_user_id: input.displacedUserId,
				},
				dedupeKey: `session.takeover:${input.takeoverId}:personal`,
			}),
			broadcast: (
				input: SessionTakeoverNotificationInput,
			): NotificationContent<z.infer<typeof SessionTakeoverDataSchema>> => ({
				title: `Editor session takeover in ${input.project.name}`,
				body: `${actorLabel(input.actor)} took over ${input.notebookTitle} in ${input.project.name}, replacing ${recipientLabel(input)}.`,
				...optionalLink(notebookLink(input.projectId, input.notebookId, input.baseUrl)),
				recipients: [],
				context: {
					pid: input.projectId,
					nid: input.notebookId,
					takeover_id: input.takeoverId,
				},
				data: {
					...projectData(input.project, input.projectId),
					notebook_id: input.notebookId,
					notebook_title: input.notebookTitle,
					takeover_id: input.takeoverId,
					actor_user_id: input.actor.id,
					displaced_user_id: input.displacedUserId,
				},
				dedupeKey: `session.takeover:${input.takeoverId}:broadcast`,
			}),
		},
	},
	'member.role_changed': {
		severity: 'warning',
		dataSchema: MemberRoleChangedDataSchema,
		render: {
			broadcast: (input: MemberRoleChangedNotificationInput) => ({
				title: `Member role changed in ${input.project.name}`,
				body: `${actorLabel(input.actor)} changed ${memberLabel(input.member)} from ${input.oldRole} to ${input.member.role}.`,
				...optionalLink(projectLink(input.project.id, input.baseUrl)),
				recipients: [],
				context: { pid: input.project.id },
				data: {
					...projectData(input.project),
					...memberData(input.member),
					old_role: input.oldRole,
					new_role: input.member.role,
					actor_user_id: input.actor.id,
				},
				dedupeKey: `member.role_changed:${input.mutationId}:broadcast`,
			}),
		},
	},
	'member.removed': {
		severity: 'warning',
		dataSchema: MemberRemovedDataSchema,
		render: {
			broadcast: (input: MemberRemovedNotificationInput) => ({
				title: `Member removed from ${input.project.name}`,
				body: `${actorLabel(input.actor)} removed ${memberLabel(input.member)} from ${input.project.name}.`,
				...optionalLink(projectLink(input.project.id, input.baseUrl)),
				recipients: [],
				context: { pid: input.project.id },
				data: {
					...projectData(input.project),
					...memberData(input.member),
					role: input.member.role,
					actor_user_id: input.actor.id,
				},
				dedupeKey: `member.removed:${input.mutationId}:broadcast`,
			}),
		},
	},
	'notebook.deleted': {
		severity: 'warning',
		dataSchema: NotebookDeletedDataSchema,
		render: {
			broadcast: (input: NotebookDeletedNotificationInput) => ({
				title: `Notebook deleted from ${input.project.name}`,
				body: `${actorLabel(input.actor)} deleted ${input.notebookTitle}.`,
				...optionalLink(projectLink(input.project.id, input.baseUrl)),
				recipients: [],
				context: { pid: input.project.id, nid: input.notebookId },
				data: {
					...notebookData(input),
					actor_user_id: input.actor.id,
				},
				dedupeKey: `notebook.deleted:${input.mutationId}:broadcast`,
			}),
		},
	},
	'project.deleted': {
		severity: 'warning',
		dataSchema: ProjectDeletedDataSchema,
		render: {
			broadcast: (input: ProjectDeletedNotificationInput) => ({
				title: `Project deleted: ${input.project.name}`,
				body: `${actorLabel(input.actor)} deleted ${input.project.name}.`,
				recipients: [],
				context: { pid: input.project.id },
				data: {
					...projectData(input.project),
					actor_user_id: input.actor.id,
				},
				dedupeKey: `project.deleted:${input.mutationId}:broadcast`,
			}),
		},
	},
	'app.start_failed': {
		severity: 'error',
		dataSchema: AppFailureDataSchema,
		render: {
			broadcast: (input: AppFailureNotificationInput) =>
				appFailureContent(
					input,
					'app.start_failed',
					`App failed to start in ${input.project.name}`,
					`${input.notebookTitle} failed to start (${input.errorCode}).`,
				),
		},
	},
	'app.unavailable': {
		severity: 'error',
		dataSchema: AppFailureDataSchema,
		render: {
			broadcast: (input: AppFailureNotificationInput) =>
				appFailureContent(
					input,
					'app.unavailable',
					`App unavailable in ${input.project.name}`,
					`${input.notebookTitle} stopped unexpectedly (${input.errorCode}).`,
				),
		},
	},
	'sync.failed': {
		severity: 'error',
		dataSchema: SyncFailedDataSchema,
		render: {
			broadcast: (input: SyncFailedNotificationInput) => ({
				title: `Git sync failed in ${input.project.name}`,
				body: `${input.notebookTitle} failed to sync commit ${input.commit.slice(0, 12)} (${input.errorCode}).`,
				...optionalLink(notebookLink(input.project.id, input.notebookId, input.baseUrl)),
				recipients: [],
				context: { pid: input.project.id, nid: input.notebookId },
				data: {
					...notebookData(input),
					commit: input.commit,
					error_code: input.errorCode,
				},
				dedupeKey: `sync.failed:${input.notebookId}:${input.commit}:broadcast`,
			}),
		},
	},
	'alert.test': {
		severity: 'info',
		dataSchema: AlertTestDataSchema,
		render: {
			broadcast: (input: AlertTestNotificationInput) => ({
				title: `Test alert for ${input.project.name}`,
				body: 'This project alert destination is configured correctly.',
				recipients: [],
				context: { pid: input.project.id },
				data: {
					...projectData(input.project),
					destination_id: input.destinationId,
					actor_user_id: input.actor.id,
					test_id: input.testId,
				},
				dedupeKey: `alert.test:${input.destinationId}:${input.testId}:broadcast`,
			}),
		},
	},
} as const;

export type NotificationKind = keyof typeof NOTIFICATION_KIND_REGISTRY;
export const GLOBAL_NOTIFICATION_KINDS = [
	'member.invited',
	'member.added',
	'session.takeover',
] as const satisfies readonly NotificationKind[];
export const NOTIFICATION_KINDS = GLOBAL_NOTIFICATION_KINDS;
export const PROJECT_ALERT_KINDS = [
	'member.invited',
	'member.added',
	'member.role_changed',
	'member.removed',
	'session.takeover',
	'notebook.deleted',
	'project.deleted',
	'app.start_failed',
	'app.unavailable',
	'sync.failed',
] as const satisfies readonly NotificationKind[];
export type ProjectAlertKind = (typeof PROJECT_ALERT_KINDS)[number];
export const ProjectAlertKindSchema = z.enum(PROJECT_ALERT_KINDS);

type DefinitionFor<K extends NotificationKind> = (typeof NOTIFICATION_KIND_REGISTRY)[K];
type AudienceFor<K extends NotificationKind> = Extract<
	keyof DefinitionFor<K>['render'],
	NotificationAudience
>;
type DataFor<K extends NotificationKind> = z.infer<DefinitionFor<K>['dataSchema']>;

type NotificationFor<K extends NotificationKind> = {
	schema_version: 1;
	kind: K;
	severity: DefinitionFor<K>['severity'];
	audience: AudienceFor<K>;
	title: string;
	body: string;
	link?: string;
	recipients: NotificationRecipient[];
	context: Record<string, string>;
	data: DataFor<K>;
	dedupe_key: string;
};

export type Notification = {
	[K in NotificationKind]: NotificationFor<K>;
}[NotificationKind];

const NotificationEnvelopeSchema = z.object({
	schema_version: z.literal(1),
	kind: z.string().min(1),
	severity: z.enum(['info', 'warning', 'error']),
	audience: NotificationAudienceSchema,
	title: z.string().min(1),
	body: z.string().min(1),
	link: z.url().optional(),
	recipients: z.array(NotificationRecipientSchema),
	context: z.record(z.string(), z.string()),
	data: z.unknown(),
	dedupe_key: z.string().min(1),
});

export const NotificationSchema = NotificationEnvelopeSchema.transform((value, context) => {
	if (!Object.hasOwn(NOTIFICATION_KIND_REGISTRY, value.kind)) {
		context.addIssue({ code: 'custom', path: ['kind'], message: 'Unknown notification kind' });
		return z.NEVER;
	}
	const kind = value.kind as NotificationKind;
	const definition = NOTIFICATION_KIND_REGISTRY[kind];
	if (value.severity !== definition.severity) {
		context.addIssue({
			code: 'custom',
			path: ['severity'],
			message: `Expected ${definition.severity} severity for ${kind}`,
		});
		return z.NEVER;
	}
	if (!Object.hasOwn(definition.render, value.audience)) {
		context.addIssue({
			code: 'custom',
			path: ['audience'],
			message: `Unsupported ${value.audience} audience for ${kind}`,
		});
		return z.NEVER;
	}
	const data = definition.dataSchema.safeParse(value.data);
	if (!data.success) {
		for (const issue of data.error.issues) {
			context.addIssue({ ...issue, path: ['data', ...issue.path] });
		}
		return z.NEVER;
	}
	const notification = { ...value, kind, data: data.data };
	return notification as Notification;
});

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
	if (member.email) {
		const result = NotificationRecipientSchema.safeParse({ email: member.email });
		return result.success ? result.data : null;
	}
	return recipientFromIdentity(identity);
}

type Renderer = (input: never) => NotificationContent<unknown>;
type RendererInput<T> = T extends (input: infer I) => NotificationContent<unknown> ? I : never;
type DefinitionInput<T> = T extends { render: infer R }
	? RendererInput<Extract<R[keyof R], Renderer>>
	: never;

export type NotificationRenderInput = {
	[K in NotificationKind]: { kind: K } & DefinitionInput<DefinitionFor<K>>;
}[NotificationKind];

export class NotificationRouter {
	render(input: NotificationRenderInput): Notification[] {
		const definition = NOTIFICATION_KIND_REGISTRY[input.kind];
		const renderers = definition.render as Record<
			string,
			(input: NotificationRenderInput) => NotificationContent<unknown>
		>;
		return Object.entries(renderers).map(([audience, render]) => {
			const content = render(input);
			return NotificationSchema.parse({
				schema_version: 1,
				kind: input.kind,
				severity: definition.severity,
				audience,
				title: content.title,
				body: content.body,
				...optionalLink(content.link),
				recipients: content.recipients,
				context: content.context,
				data: content.data,
				dedupe_key: content.dedupeKey,
			});
		});
	}
}

export const notificationRouter = new NotificationRouter();
