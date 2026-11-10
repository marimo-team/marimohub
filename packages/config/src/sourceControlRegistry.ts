import type {
	SourceControlPublisher,
	SourceControlReader,
	SourceControlRegistry,
	WorkingBranchWriter,
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
	readonly workingBranchesEnabled: boolean;
	private readonly workingBranchProviderIds: readonly string[];

	constructor(
		registrations: readonly SourceControlRegistration[],
		options: { workingBranchesEnabled?: boolean } = {},
	) {
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
		this.workingBranchProviderIds = [...this.publishers.values()]
			.filter(
				({ publisher }) =>
					publisher.workingBranches &&
					this.readers.get(publisher.provider)?.reader.fetchGitDirectory,
			)
			.map(({ publisher }) => publisher.provider);
		this.workingBranchesEnabled =
			(options.workingBranchesEnabled ?? false) && this.workingBranchProviderIds.length > 0;
	}

	assertRepositoryAllowed(provider: string, repository: string, projectId: ProjectId): void {
		const policies = new Set([
			this.readers.get(provider)?.authorize,
			this.publishers.get(provider)?.authorize,
		]);
		for (const authorize of policies) authorize?.(repository, projectId);
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
		const workingBranches =
			this.workingBranchesEnabled && this.readers.get(provider)?.reader.fetchGitDirectory
				? publisher.workingBranches
				: undefined;
		if (!authorize && workingBranches === publisher.workingBranches) return publisher;
		const check = authorize ?? (() => {});
		const updateChangeRequest = publisher.updateChangeRequest?.bind(publisher);
		return {
			provider,
			openChangeRequest: this.guard(publisher.openChangeRequest.bind(publisher), check, projectId),
			...(updateChangeRequest
				? { updateChangeRequest: this.guard(updateChangeRequest, check, projectId) }
				: {}),
			...(workingBranches
				? { workingBranches: this.guardWorkingBranches(workingBranches, check, projectId) }
				: {}),
		};
	}

	private guardWorkingBranches(
		writer: WorkingBranchWriter,
		authorize: AuthorizeRepository,
		projectId?: ProjectId,
	): WorkingBranchWriter {
		return {
			createBranch: this.guard(writer.createBranch.bind(writer), authorize, projectId),
			prepareCommit: this.guard(writer.prepareCommit.bind(writer), authorize, projectId),
			advanceBranch: this.guard(writer.advanceBranch.bind(writer), authorize, projectId),
			openBranchChangeRequest: this.guard(
				writer.openBranchChangeRequest.bind(writer),
				authorize,
				projectId,
			),
			inspectBranch: this.guard(writer.inspectBranch.bind(writer), authorize, projectId),
		};
	}

	workingBranchProviders(): readonly string[] {
		return this.workingBranchesEnabled ? this.workingBranchProviderIds : [];
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
