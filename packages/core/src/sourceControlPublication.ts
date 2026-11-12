import { z } from 'zod';

export const PublicationActorSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('app'), verification: z.enum(['unchecked', 'required']) }),
	z.object({
		kind: z.literal('user'),
		verification: z.enum(['unchecked', 'required']),
		userId: z.string(),
		connectionId: z.string(),
		generation: z.string(),
		accountId: z.string(),
	}),
]);
export type PublicationActor = z.infer<typeof PublicationActorSchema>;
export const SignedPreparationSchema = z.object({
	protocol: z.literal('github-graphql-v1'),
	branch: z.string(),
	repository: z.string(),
	accountId: z.string(),
	ownedHead: z.string().optional(),
	parent: z.string(),
	tree: z.string(),
	message: z.string(),
	dispatched: z.boolean(),
	commit: z.string().optional(),
	cleaned: z.boolean().optional(),
});
export type SignedPreparation = z.infer<typeof SignedPreparationSchema>;
export interface PreparationCheckpoint {
	assertCurrent?(): Promise<void>;
	read(): Promise<SignedPreparation | undefined>;
	write(value: SignedPreparation): Promise<void>;
}

export const CommitVerificationSchema = z.object({
	status: z.literal('verified'),
	commit: z.string(),
	url: z.url().refine((url) => url.startsWith('https://')),
});
export type CommitVerification = z.infer<typeof CommitVerificationSchema>;
