import type {
	SourceControlPublisher,
	SourceControlReader,
	SourceControlRegistry,
} from '@marimo-hub/core/ports/source-control';
import type { ProjectId } from '@marimo-hub/core/ids';
import { ConfigError } from './errors';

type AuthorizeRepository = (repository: string, projectId?: ProjectId) => void;
type RepositoryArgument = string | { repository: string };

export class ConfiguredSourceControlRegistry implements SourceControlRegistry {
	private readonly publishers: Map<string, SourceControlPublisher>;
	private readonly readers: Map<string, SourceControlReader>;

	constructor(
		publishers: readonly SourceControlPublisher[],
		readers: readonly SourceControlReader[],
		private readonly authorize?: AuthorizeRepository,
	) {
		this.publishers = new Map(publishers.map((publisher) => [publisher.provider, publisher]));
		this.readers = new Map(readers.map((reader) => [reader.provider, reader]));
		if (this.publishers.size !== publishers.length || this.readers.size !== readers.length) {
			throw new ConfigError('Source-control provider ids must be unique');
		}
	}

	getReader(provider: string, projectId?: ProjectId): SourceControlReader | undefined {
		const reader = this.readers.get(provider);
		if (!reader || !this.authorize) return reader;
		const fetchGitDirectory = reader.fetchGitDirectory?.bind(reader);
		return {
			provider,
			supportsRepository: (repository) => {
				if (!reader.supportsRepository(repository)) return false;
				this.authorize!(repository, projectId);
				return true;
			},
			getBranchHead: this.guard(reader.getBranchHead.bind(reader), projectId),
			fetchWorkspace: this.guard(reader.fetchWorkspace.bind(reader), projectId),
			...(fetchGitDirectory ? { fetchGitDirectory: this.guard(fetchGitDirectory, projectId) } : {}),
		};
	}

	getPublisher(provider: string, projectId?: ProjectId): SourceControlPublisher | undefined {
		const publisher = this.publishers.get(provider);
		if (!publisher || !this.authorize) return publisher;
		const updateChangeRequest = publisher.updateChangeRequest?.bind(publisher);
		return {
			provider,
			openChangeRequest: this.guard(publisher.openChangeRequest.bind(publisher), projectId),
			...(updateChangeRequest
				? { updateChangeRequest: this.guard(updateChangeRequest, projectId) }
				: {}),
		};
	}

	publisherProviders(): readonly string[] {
		return [...this.publishers.keys()];
	}

	readerProviders(): readonly string[] {
		return [...this.readers.keys()];
	}

	pullSourceProviders(): readonly string[] {
		return [...this.readers.values()]
			.filter((reader) => reader.fetchGitDirectory)
			.map((reader) => reader.provider);
	}

	private guard<Args extends [RepositoryArgument, ...unknown[]], Result>(
		operation: (...args: Args) => Promise<Result>,
		projectId?: ProjectId,
	): (...args: Args) => Promise<Result> {
		return async (...args) => {
			const first = args[0];
			this.authorize!(typeof first === 'string' ? first : first.repository, projectId);
			return operation(...args);
		};
	}
}
