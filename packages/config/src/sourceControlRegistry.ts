import type {
	SourceControlPublisher,
	SourceControlReader,
	SourceControlRegistry,
} from '@marimo-hub/core/ports/source-control';
import type { ProjectId } from '@marimo-hub/core/ids';
import type { GitProvider, GitProviderHosts } from '@marimo-hub/core/git-repo';
import { ConfigError } from './errors';

export type AuthorizeRepository = (repository: string, projectId?: ProjectId) => void;
type RepositoryArgument = string | { repository: string };

export interface SourceControlRegistration {
	reader?: SourceControlReader;
	publisher?: SourceControlPublisher;
	authorize?: AuthorizeRepository;
	repositoryHosts?: SourceControlRegistry['repositoryHosts'];
}

export class ConfiguredSourceControlRegistry implements SourceControlRegistry {
	private readonly publishers = new Map<
		string,
		SourceControlRegistration & { publisher: SourceControlPublisher }
	>();
	private readonly readers = new Map<
		string,
		SourceControlRegistration & { reader: SourceControlReader }
	>();
	readonly repositoryHosts: GitProviderHosts;

	constructor(registrations: readonly SourceControlRegistration[]) {
		const hosts: Record<string, GitProvider> = Object.create(null);
		for (const registration of registrations) {
			const { reader, publisher } = registration;
			if (reader) {
				if (this.readers.has(reader.provider))
					throw new ConfigError('Source-control provider ids must be unique');
				this.readers.set(reader.provider, { ...registration, reader });
			}
			if (publisher) {
				if (this.publishers.has(publisher.provider))
					throw new ConfigError('Source-control provider ids must be unique');
				this.publishers.set(publisher.provider, { ...registration, publisher });
			}
			for (const [host, provider] of Object.entries(registration.repositoryHosts ?? {})) {
				if (Object.hasOwn(hosts, host) && hosts[host] !== provider)
					throw new ConfigError(`Source-control host ${host} has conflicting providers`);
				hosts[host] = provider;
			}
		}
		this.repositoryHosts = hosts;
	}

	getReader(provider: string, projectId?: ProjectId): SourceControlReader | undefined {
		const registration = this.readers.get(provider);
		if (!registration) return undefined;
		const { reader, authorize } = registration;
		if (!authorize) return reader;
		const fetchGitDirectory = reader.fetchGitDirectory?.bind(reader);
		return {
			provider,
			previews: reader.previews,
			...(reader.listBranches
				? { listBranches: this.guard(reader.listBranches.bind(reader), authorize, projectId) }
				: {}),
			...(reader.listCommits
				? { listCommits: this.guard(reader.listCommits.bind(reader), authorize, projectId) }
				: {}),
			...(reader.resolveCommit
				? { resolveCommit: this.guard(reader.resolveCommit.bind(reader), authorize, projectId) }
				: {}),
			...(reader.getPullRequest
				? { getPullRequest: this.guard(reader.getPullRequest.bind(reader), authorize, projectId) }
				: {}),
			supportsRepository: (repository) => {
				if (!reader.supportsRepository(repository)) return false;
				authorize(repository, projectId);
				return true;
			},
			getBranchHead: this.guard(reader.getBranchHead.bind(reader), authorize, projectId),
			fetchWorkspace: this.guard(reader.fetchWorkspace.bind(reader), authorize, projectId),
			...(fetchGitDirectory
				? { fetchGitDirectory: this.guard(fetchGitDirectory, authorize, projectId) }
				: {}),
		};
	}

	getPublisher(provider: string, projectId?: ProjectId): SourceControlPublisher | undefined {
		const registration = this.publishers.get(provider);
		if (!registration) return undefined;
		const { publisher, authorize } = registration;
		if (!authorize) return publisher;
		const updateChangeRequest = publisher.updateChangeRequest?.bind(publisher);
		return {
			provider,
			openChangeRequest: this.guard(
				publisher.openChangeRequest.bind(publisher),
				authorize,
				projectId,
			),
			...(updateChangeRequest
				? { updateChangeRequest: this.guard(updateChangeRequest, authorize, projectId) }
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
			.filter(({ reader }) => reader.fetchGitDirectory)
			.map(({ reader }) => reader.provider);
	}

	private guard<Args extends [RepositoryArgument, ...unknown[]], Result>(
		operation: (...args: Args) => Promise<Result>,
		authorize: AuthorizeRepository,
		projectId?: ProjectId,
	): (...args: Args) => Promise<Result> {
		return async (...args) => {
			const first = args[0];
			authorize(typeof first === 'string' ? first : first.repository, projectId);
			return operation(...args);
		};
	}
}
