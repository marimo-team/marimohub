import {
	ConflictError,
	NotFoundError,
	PreconditionFailedError,
	ResourceExhaustedError,
} from '../../errors';
import type { NotebookId, ProjectId, VersionId } from '../../ids';
import { paths } from '../../paths';
import type { Bucket } from '../../ports/bucket';
import { readStored, SourceSchema, VersionSchema } from '../../schema';
import type {
	LocalSource,
	LocalPublicationVersion,
	PublicationArtifact,
	Version,
} from '../../schema';
import { listAllPrefixes } from '../catalog/storage';
import { mapWithConcurrency } from '../../concurrency';
import { BUCKET_SCAN_CONCURRENCY } from '../../constants';

/** NotebookService's source-head token. Acquire before reading runtime artifacts. */
export interface LocalPublicationToken {
	projectId: ProjectId;
	notebookId: NotebookId;
	etag: string;
	source: LocalSource;
	versions: LocalPublicationVersion[];
}

export async function readLocalPublication(
	bucket: Bucket,
	projectId: ProjectId,
	notebookId: NotebookId,
	retainLegacyVersions?: ReadonlySet<string>,
): Promise<LocalPublicationToken> {
	const nb = paths.project(projectId).notebook(notebookId);
	const object = await bucket.get(nb.source);
	if (!object) throw new NotFoundError(`Notebook ${notebookId} source not found`);
	const source = await readStored(SourceSchema, object, nb.source);
	if (source.type !== 'local')
		throw new ConflictError('Only local notebooks accept session captures');
	let versions = source.publication?.versions;
	if (!versions) {
		const prefixes = await listAllPrefixes(bucket, `${nb.base}/versions/`);
		const retainedPrefixes = retainLegacyVersions
			? prefixes.filter((prefix) =>
					retainLegacyVersions.has(prefix.slice(`${nb.base}/versions/`.length, -1)),
				)
			: prefixes;
		const legacy = await mapWithConcurrency(
			retainedPrefixes,
			BUCKET_SCAN_CONCURRENCY,
			async (prefix) => {
				const key = `${prefix}version.json`;
				const object = await bucket.get(key);
				if (!object) return;
				const version = await readStored(VersionSchema, object, key);
				return {
					version_id: version.version_id,
					html_snapshot: version.html_snapshot,
					session_snapshot: version.session_snapshot,
				};
			},
		);
		versions = legacy.filter((version): version is NonNullable<typeof version> => !!version);
		if (versions.length > 1000)
			throw new ResourceExhaustedError(
				'Notebook history exceeds the publication limit; reduce retained history before saving',
			);
		const initialized: LocalSource = {
			...source,
			publication: { generation: crypto.randomUUID(), versions },
		};
		try {
			const written = await bucket.put(nb.source, JSON.stringify(initialized), {
				onlyIfEtagMatches: object.etag,
			});
			return { projectId, notebookId, etag: written.etag, source: initialized, versions };
		} catch (error) {
			if (!(error instanceof PreconditionFailedError)) throw error;
			const current = await bucket.get(nb.source);
			if (!current) throw new NotFoundError(`Notebook ${notebookId} source not found`);
			const adopted = await readStored(SourceSchema, current, nb.source);
			if (adopted.type !== 'local' || !adopted.publication)
				throw new ConflictError('Notebook publication initialization changed; retry');
			return {
				projectId,
				notebookId,
				etag: current.etag,
				source: adopted,
				versions: adopted.publication.versions,
			};
		}
	}
	return { projectId, notebookId, etag: object.etag, source, versions };
}

export async function publishLocalSource(
	bucket: Bucket,
	token: LocalPublicationToken,
	currentVersion: VersionId,
	versions: LocalPublicationVersion[],
): Promise<LocalSource> {
	if (versions.length > 1000)
		throw new ResourceExhaustedError(
			'Notebook publication history is full; run retention before saving',
		);
	const next: LocalSource = {
		...token.source,
		current_version_id: currentVersion,
		publication: { generation: crypto.randomUUID(), versions },
	};
	try {
		await bucket.put(
			paths.project(token.projectId).notebook(token.notebookId).source,
			JSON.stringify(next),
			{
				onlyIfEtagMatches: token.etag,
			},
		);
	} catch (error) {
		if (error instanceof PreconditionFailedError)
			throw new ConflictError(
				'Notebook publication changed during capture; capture again before retrying',
			);
		throw error;
	}
	return next;
}

export function publishedVersion(source: LocalSource, version: Version): Version {
	const publication = source.publication?.versions.find(
		(item) => item.version_id === version.version_id,
	);
	if (!publication) return version;
	const descriptor = (value?: PublicationArtifact) =>
		value && { captured_at: value.captured_at, size_bytes: value.size_bytes };
	return {
		...version,
		html_snapshot: descriptor(publication.html_snapshot),
		session_snapshot: descriptor(publication.session_snapshot),
	};
}

export function publicationArtifactKey(
	projectId: ProjectId,
	notebookId: NotebookId,
	versionId: VersionId,
	field: 'html' | 'session',
	descriptor?: PublicationArtifact,
): string {
	const version = paths.project(projectId).notebook(notebookId).version(versionId);
	return descriptor?.capture_id ? version.capture(descriptor.capture_id)[field] : version[field];
}
