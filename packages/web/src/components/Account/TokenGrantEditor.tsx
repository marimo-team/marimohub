import { useMemo, useState } from 'react';
import {
	AUTHORIZATION_ACTIONS,
	MAX_TOKEN_GRANT_PROJECTS,
	TOKEN_GRANT_PRESETS,
} from '@marimo-hub/core/token-grants';
import type { AuthorizationAction } from '@marimo-hub/core/token-grants';
import { SearchField } from '@/components/ui';
import { useProjectsQuery } from '@/api/hooks';
import type { TokenGrant } from '@/types';

export interface TokenGrantDraft {
	actions: TokenGrant['actions'] | null;
	projects: TokenGrant['projects'] | null;
}

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
	return a !== null && a.length === b.length && a.every((action) => b.includes(action));
}

function actionsFit(actions: TokenGrant['actions'], upperBound: TokenGrant | undefined): boolean {
	return (
		!upperBound ||
		upperBound.actions === '*' ||
		(actions !== '*' && actions.every((action) => upperBound.actions.includes(action)))
	);
}

export function TokenGrantEditor({ value, onChange, upperBound }: TokenGrantEditorProps) {
	const [advanced, setAdvanced] = useState(false);
	const [search, setSearch] = useState('');
	const { data: projects = [] } = useProjectsQuery({ q: search.trim() || undefined });
	const selectedPreset = PRESETS.find((preset) =>
		sameActions(value.actions, presetActions(preset.id)),
	);
	const allowedProjects = useMemo(() => {
		const bound = upperBound?.projects;
		return bound === '*' || bound === undefined
			? projects
			: projects.filter((project) => bound.includes(project.id));
	}, [projects, upperBound?.projects]);
	const selectedProjects = Array.isArray(value.projects) ? value.projects : [];

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
						const disabled = !actionsFit(actions, upperBound);
						return (
							<label
								key={preset.id}
								aria-label={preset.label}
								className="flex cursor-pointer gap-2 rounded-md border p-2 has-checked:border-primary has-checked:bg-primary/5 has-disabled:cursor-not-allowed has-disabled:opacity-50"
							>
								<input
									aria-label={preset.label}
									type="radio"
									name="token-action-preset"
									checked={selectedPreset?.id === preset.id && !advanced}
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
				{advanced ? (
					<div className="grid max-h-48 gap-1 overflow-y-auto rounded-md border p-2 sm:grid-cols-2">
						{AUTHORIZATION_ACTIONS.map((action) => {
							const disabled =
								upperBound?.actions !== undefined &&
								upperBound.actions !== '*' &&
								!upperBound.actions.includes(action);
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
						<div className="max-h-40 overflow-y-auto">
							{allowedProjects.map((project) => (
								<label key={project.id} className="flex items-center gap-2 py-1 text-xs">
									<input
										aria-label={project.name}
										type="checkbox"
										checked={selectedProjects.includes(project.id)}
										disabled={
											!selectedProjects.includes(project.id) &&
											selectedProjects.length >= MAX_TOKEN_GRANT_PROJECTS
										}
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
							))}
						</div>
						<span className="text-xs text-muted-foreground">
							{selectedProjects.length} of {MAX_TOKEN_GRANT_PROJECTS} projects selected
						</span>
					</div>
				) : null}
			</fieldset>
		</div>
	);
}

export function tokenGrantFromDraft(value: TokenGrantDraft): TokenGrant | null {
	if (value.actions === null || value.projects === null) return null;
	if (Array.isArray(value.projects) && value.projects.length === 0) return null;
	return { actions: value.actions, projects: value.projects };
}
