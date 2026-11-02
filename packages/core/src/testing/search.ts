import type {
	SearchRetriever,
	SearchSnapshotStore,
	SearchScope,
	SearchSnapshot,
	SearchCandidatesRequest,
	SearchBuild,
} from '../search/contracts';
import { canClaimSearchBuild, sameSearchBuild } from '../search/build';
import {
	terms,
	SearchSnapshotSchema,
	SearchBuildSchema,
	MAX_INDEX_BYTES,
} from '../search/contracts';
import { MAX_SEARCH_CANDIDATES } from '../search/limits';

export class MemorySearchIndex implements SearchRetriever, SearchSnapshotStore {
	private readonly records = new Map<
		string,
		{ revision: string; snapshot: SearchSnapshot | null; build?: SearchBuild; deleted: boolean }
	>();
	private generation = 0;
	async head(scope: SearchScope) {
		const { revision, build, deleted } = this.records.get(`${scope.projectId}/${scope.source}`) ?? {
			revision: null,
			deleted: false,
		};
		return { revision, build, deleted };
	}
	async claim(scope: SearchScope, input: SearchBuild) {
		const build = SearchBuildSchema.parse(input);
		const key = `${scope.projectId}/${scope.source}`;
		const current = this.records.get(key);
		if (current?.deleted || !canClaimSearchBuild(current?.build, build)) return null;
		if (current && sameSearchBuild(current.build, build)) return current;
		const snapshot = current?.snapshot ?? null;
		const next = { revision: String(++this.generation), snapshot, build, deleted: false };
		this.records.set(key, next);
		return { revision: next.revision, build, deleted: false };
	}
	async read(scope: SearchScope) {
		return (
			this.records.get(`${scope.projectId}/${scope.source}`) ?? { revision: null, snapshot: null }
		);
	}
	async publish(scope: SearchScope, input: SearchSnapshot | null, revision: string | null) {
		const key = `${scope.projectId}/${scope.source}`;
		const current = this.records.get(key);
		if ((current?.revision ?? null) !== revision || (input && current?.deleted)) return false;
		const snapshot = input ? SearchSnapshotSchema.parse(input) : null;
		if (snapshot && new TextEncoder().encode(JSON.stringify(snapshot)).length > MAX_INDEX_BYTES)
			throw new Error('Search snapshot exceeds budget');
		this.records.set(key, {
			revision: String(++this.generation),
			snapshot,
			build: current?.build,
			deleted: snapshot === null,
		});
		return true;
	}
	async candidates(scope: SearchScope, { query, kinds, embedding }: SearchCandidatesRequest) {
		const { snapshot } = await this.read(scope);
		const documents =
			snapshot?.documents.filter(
				(d) =>
					(!kinds || kinds.includes(d.kind)) &&
					((embedding &&
						d.embedding?.space === embedding.space &&
						d.embedding.vector.length === embedding.vector.length) ||
						terms(query).some((t) => terms(`${d.title} ${d.text}`).includes(t))),
			) ?? [];
		return {
			documents: documents.slice(0, MAX_SEARCH_CANDIDATES),
			indexedAt: snapshot?.indexed_at,
			partial: !snapshot || snapshot.partial || documents.length > MAX_SEARCH_CANDIDATES,
		};
	}
}
