import { z } from 'zod';
import { proposalSha256 } from './proposalUtils';

export const WorkspaceManifestSchema = z.array(
	z.object({
		path: z.string(),
		size_bytes: z.number().int().nonnegative(),
		sha256: z.string().regex(/^[0-9a-f]{64}$/),
	}),
);

export async function workspaceManifest(files: ReadonlyMap<string, Uint8Array>) {
	return Promise.all(
		[...files].map(async ([path, bytes]) => ({
			path,
			size_bytes: bytes.byteLength,
			sha256: await proposalSha256(bytes),
		})),
	);
}
