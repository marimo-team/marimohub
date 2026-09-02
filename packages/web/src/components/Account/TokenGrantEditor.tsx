import { useMemo, useState } from 'react';
import {
	AUTHORIZATION_ACTIONS,
	MAX_TOKEN_GRANT_PROJECTS,
	TOKEN_GRANT_PRESETS,
} from '@marimo-hub/core/token-grants';
import type { AuthorizationAction } from '@marimo-hub/core/token-grants';
import { Button, SearchField } from '@/components/ui';
import { useProjectsQuery } from '@/api/hooks';
import { errorMessage } from '@/lib/errors';
import { cn } from '@/lib/utils';
import type { TokenGrant } from '@/types';
import type { TokenGrantDraft } from './tokenGrantDraft';

interface TokenGrantEditorProps {
	value: TokenGrantDraft;
	onChange: (value: TokenGrantDraft) => void;
	upperBound?: TokenGrant;
}

const PRESETS = [
	{ id: 'read', label: 'Read', description: 'Read projects and integration settings.' },
	{ id: 'run', label: 'Run notebooks', description: 'Read projects and use notebook sessions.' },
	{
		id: 'edit',
		label: 'Edit notebooks',
		description: 'Run notebooks, edit content, and publish changes.',
	},
	{ id: 'full', label: 'Full', description: 'Use all current and future actions.' },
] as const;

function presetActions(id: (typeof PRESETS)[number]['id']): TokenGrant['actions'] {
	const actions = TOKEN_GRANT_PRESETS[id];
	return actions === '*' ? '*' : [...actions];
}

function sameActions(a: TokenGrant['actions'] | null, b: TokenGrant['actions']): boolean {
	if (a === '*' || b === '*') return a === b;
	if (a === null || a.length !== b.length) return false;
	const expected = new Set(b);
	return a.every((action) => expected.has(action));
}

function actionsFit(
	actions: TokenGrant['actions'],
	upperBound: TokenGrant | undefined,
	upperBoundActions: ReadonlySet<AuthorizationAction> | null,
): boolean {
	return (
		!upperBound ||
		upperBound.actions === '*' ||
		(actions !== '*' && actions.every((action) => upperBoundActions?.has(action)))
	);
}

export function TokenGrantEditor({ value, onChange, upperBound }: TokenGrantEditorProps) {
	const [advanced, setAdvanced] = useState(false);
	const [search, setSearch] = useState('');
	const selectedProjects = Array.isArray(value.projects) ? value.projects : [];
	const projectsQuery = useProjectsQuery(
		{ q: search.trim() || undefined },
		{ enabled: Array.isArray(value.projects), throwOnError: false },
	);
	const upperBoundActions = useMemo(
		() => (Array.isArray(upperBound?.actions) ? new Set(upperBound.actions) : null),
		[upperBound?.actions],
	);
	const upperBoundProjects = useMemo(
		() => (Array.isArray(upperBound?.projects) ? new Set(upperBound.projects) : null),
		[upperBound?.projects],
	);
	const selectedProjectIds = useMemo(
		() => new Set(Array.isArray(value.projects) ? value.projects : []),
		[value.projects],
	);
	const selectedPreset = PRESETS.find((preset) =>
		sameActions(value.actions, presetActions(preset.id)),
	);
	const showAdvanced = advanced || (value.actions !== null && selectedPreset === undefined);
	const allowedProjects = useMemo(() => {
		const projects = projectsQuery.data ?? [];
		return upperBoundProjects === null
			? projects
			: projects.filter((project) => upperBoundProjects.has(project.id));
	}, [projectsQuery.data, upperBoundProjects]);

	const setAction = (action: AuthorizationAction, selected: boolean) => {
		const current = value.actions === '*' || value.actions === null ? [] : value.actions;
		onChange({
			...value,
			actions: selected ? [...current, action] : current.filter((item) => item !== action),
		});
	};

	return (
		<div className="flex flex-col gap-4">
			<fieldset className="flex flex-col gap-2">
				<legend className="text-xs font-semibold">Actions</legend>
				<div className="grid gap-2 sm:grid-cols-2">
					{PRESETS.map((preset) => {
						const actions = presetActions(preset.id);
						const disabled = !actionsFit(actions, upperBound, upperBoundActions);
						const checked = selectedPreset?.id === preset.id && !showAdvanced;
						return (
							<label
								key={preset.id}
								aria-label={preset.label}
								className={cn(
									'flex gap-2 rounded-md border p-2',
									checked && 'border-primary bg-primary/5',
									disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
								)}
							>
								<input
									aria-label={preset.label}
									type="radio"
									name="token-action-preset"
									checked={checked}
									disabled={disabled}
									onChange={() => {
										setAdvanced(false);
										onChange({ ...value, actions });
									}}
								/>
								<span className="flex flex-col">
									<span className="text-xs font-medium">{preset.label}</span>
									<span className="text-xs text-muted-foreground">{preset.description}</span>
								</span>
							</label>
						);
					})}
				</div>
				<button
					type="button"
					className="self-start text-xs text-primary hover:underline"
					onClick={() => {
						setAdvanced(true);
						if (value.actions === null || value.actions === '*') {
							onChange({
								...value,
								actions: value.actions === '*' ? [...AUTHORIZATION_ACTIONS] : [],
							});
						}
					}}
				>
					Advanced actions
				</button>
				{showAdvanced ? (
					<div className="grid max-h-40 gap-1 overflow-y-auto rounded-md border p-2 sm:grid-cols-2">
						{AUTHORIZATION_ACTIONS.map((action) => {
							const disabled = upperBoundActions !== null && !upperBoundActions.has(action);
							return (
								<label key={action} className="flex items-center gap-2 text-xs">
									<input
										aria-label={action}
										type="checkbox"
										checked={value.actions !== '*' && value.actions?.includes(action) === true}
										disabled={disabled}
										onChange={(event) => setAction(action, event.target.checked)}
									/>
									{action}
								</label>
							);
						})}
					</div>
				) : null}
			</fieldset>

			<fieldset className="flex flex-col gap-2">
				<legend className="text-xs font-semibold">Projects</legend>
				<label className="flex items-center gap-2 text-xs">
					<input
						aria-label="All projects, including future projects"
						type="radio"
						name="token-project-scope"
						checked={value.projects === '*'}
						disabled={upperBound?.projects !== undefined && upperBound.projects !== '*'}
						onChange={() => onChange({ ...value, projects: '*' })}
					/>
					All projects, including future projects
				</label>
				<label className="flex items-center gap-2 text-xs">
					<input
						aria-label="Selected projects"
						type="radio"
						name="token-project-scope"
						checked={Array.isArray(value.projects)}
						onChange={() => onChange({ ...value, projects: [] })}
					/>
					Selected projects
				</label>
				{Array.isArray(value.projects) ? (
					<div className="flex flex-col gap-2 rounded-md border p-2">
						<p className="text-xs text-muted-foreground">
							Selected-project tokens cannot use deployment-level actions.
						</p>
						<SearchField
							label="Search projects"
							value={search}
							onChange={setSearch}
							placeholder="Project name"
						/>
						{projectsQuery.isError ? (
							<div role="alert" className="flex flex-col gap-2 text-xs text-destructive">
								<span>{errorMessage(projectsQuery.error)}</span>
								<Button type="button" size="sm" onPress={() => void projectsQuery.refetch()}>
									Retry projects
								</Button>
							</div>
						) : (
							<div className="max-h-40 overflow-y-auto">
								{allowedProjects.map((project) => {
									const selected = selectedProjectIds.has(project.id);
									return (
										<label key={project.id} className="flex items-center gap-2 py-1 text-xs">
											<input
												aria-label={project.name}
												type="checkbox"
												checked={selected}
												disabled={!selected && selectedProjects.length >= MAX_TOKEN_GRANT_PROJECTS}
												onChange={(event) => {
													onChange({
														...value,
														projects: event.target.checked
															? [...selectedProjects, project.id]
															: selectedProjects.filter((id) => id !== project.id),
													});
												}}
											/>
											{project.name}
										</label>
									);
								})}
							</div>
						)}
						<span className="text-xs text-muted-foreground">
							{selectedProjects.length} of {MAX_TOKEN_GRANT_PROJECTS} projects selected
						</span>
					</div>
				) : null}
			</fieldset>
		</div>
	);
}
