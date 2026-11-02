import type { SearchKind } from '@/api/search';
import { Select } from '@/components/ui/Select';
import { searchKinds } from './presentation';

export function SearchFilters({
	projectId,
	projectName,
	projects,
	kinds,
	kind,
	validKind,
	onProjectChange,
	onKindChange,
}: {
	projectId?: string;
	projectName?: string;
	projects: { id: string; name: string }[];
	kinds: SearchKind[];
	kind: string | null;
	validKind: boolean;
	onProjectChange: (id: string) => void;
	onKindChange: (kind: string) => void;
}) {
	const projectOptions = [
		{ id: '', label: 'All projects' },
		...(projectId && !projects.some((project) => project.id === projectId)
			? [{ id: projectId, label: projectName ?? 'Current project' }]
			: []),
		...projects.map((project) => ({ id: project.id, label: project.name })),
	];
	const kindOptions = [
		{ id: '', label: 'All types' },
		...(!validKind ? [{ id: kind ?? '', label: 'Unavailable type' }] : []),
		...kinds.map((value) => ({ id: value, label: searchKinds[value].label })),
	];
	return (
		<div className="flex min-w-0 flex-wrap gap-3">
			<Select
				label="Scope"
				value={projectId ?? ''}
				onChange={onProjectChange}
				options={projectOptions}
				className="w-full sm:w-64"
			/>
			<Select
				label="Type"
				value={kind ?? ''}
				onChange={onKindChange}
				options={kindOptions}
				className="w-full sm:w-44"
			/>
		</div>
	);
}
