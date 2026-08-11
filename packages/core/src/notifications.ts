import { z } from 'zod';
import { ROLES } from './constants';
import type { NotebookId, ProjectId, UserId } from './ids';
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

const MemberInvitedDataSchema = z.object({
	project_id: ProjectIdSchema,
	project_name: z.string().min(1),
	role: z.enum(ROLES),
	member_email: EmailAddressSchema,
	actor_user_id: UserIdSchema,
});

const MemberAddedDataSchema = z.object({
	project_id: ProjectIdSchema,
	project_name: z.string().min(1),
	role: z.enum(ROLES),
	member_user_id: UserIdSchema,
	actor_user_id: UserIdSchema,
});

const SessionTakeoverDataSchema = z.object({
	project_id: ProjectIdSchema,
	project_name: z.string().min(1),
	notebook_id: NotebookIdSchema,
	notebook_title: z.string().min(1),
	takeover_id: z.string().min(1),
	actor_user_id: UserIdSchema,
	displaced_user_id: UserIdSchema,
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

function hubLink(baseUrl: string | undefined, path: string): string | undefined {
	if (!baseUrl) return undefined;
	return new URL(path, baseUrl).toString();
}

function actorLabel(actor: AuthUser): string {
	return actor.name?.trim() || actor.email;
}

function recipientLabel(input: SessionTakeoverNotificationInput): string {
	return input.recipient?.name ?? input.recipient?.email ?? input.displacedUserId;
}

function memberLink(input: MemberInvitedNotificationInput | MemberAddedNotificationInput) {
	return hubLink(input.baseUrl, `/projects/${encodeURIComponent(input.project.id)}`);
}

function takeoverLink(input: SessionTakeoverNotificationInput) {
	return hubLink(
		input.baseUrl,
		`/projects/${encodeURIComponent(input.projectId)}/notebooks/${encodeURIComponent(input.notebookId)}`,
	);
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
				...(memberLink(input) ? { link: memberLink(input) } : {}),
				recipients: input.recipient ? [input.recipient] : [],
				context: { pid: input.project.id, role: input.member.role },
				data: {
					project_id: input.project.id,
					project_name: input.project.name,
					role: input.member.role,
					member_email: input.member.email,
					actor_user_id: input.actor.id,
				},
				dedupeKey: `member.invited:${input.mutationId}:personal`,
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
				...(memberLink(input) ? { link: memberLink(input) } : {}),
				recipients: input.recipient ? [input.recipient] : [],
				context: { pid: input.project.id, role: input.member.role },
				data: {
					project_id: input.project.id,
					project_name: input.project.name,
					role: input.member.role,
					member_user_id: input.member.user_id,
					actor_user_id: input.actor.id,
				},
				dedupeKey: `member.added:${input.mutationId}:personal`,
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
				...(takeoverLink(input) ? { link: takeoverLink(input) } : {}),
				recipients: input.recipient ? [input.recipient] : [],
				context: {
					pid: input.projectId,
					nid: input.notebookId,
					takeover_id: input.takeoverId,
				},
				data: {
					project_id: input.projectId,
					project_name: input.project.name,
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
				...(takeoverLink(input) ? { link: takeoverLink(input) } : {}),
				recipients: [],
				context: {
					pid: input.projectId,
					nid: input.notebookId,
					takeover_id: input.takeoverId,
				},
				data: {
					project_id: input.projectId,
					project_name: input.project.name,
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
} as const;

export type NotificationKind = keyof typeof NOTIFICATION_KIND_REGISTRY;
export const NOTIFICATION_KINDS = Object.freeze(
	Object.keys(NOTIFICATION_KIND_REGISTRY) as NotificationKind[],
);

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
	}
	if (!Object.hasOwn(definition.render, value.audience)) {
		context.addIssue({
			code: 'custom',
			path: ['audience'],
			message: `Unsupported ${value.audience} audience for ${kind}`,
		});
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
				...(content.link ? { link: content.link } : {}),
				recipients: content.recipients,
				context: content.context,
				data: content.data,
				dedupe_key: content.dedupeKey,
			});
		});
	}
}

export const notificationRouter = new NotificationRouter();
