import { useLocation, useNavigate } from 'react-router-dom';
import { notebookQueryParams } from '@/lib/notebookUrls';
import { Bot, Camera, Code2, Play, Square } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { useSurfaceActions } from '@/api/surfaces';
import { DropdownMenu } from '@/components/ui';
import type { DropdownMenuOption } from '@/components/ui';
import { SURFACE_LABELS } from '@/lib/surfaces';
import type { Capabilities, NotebookDetail, SecondarySurfaceId, Session } from '@/types';

export interface SecondarySurfaceFrame {
	sessionId: string;
	surfaceId: SecondarySurfaceId;
	label: string;
	url: string;
	embed: 'tab' | 'iframe';
}

interface SurfaceDefinition {
	id: SecondarySurfaceId;
	label: string;
	icon: LucideIcon;
	openPath?: (notebook: NotebookDetail) => string;
}

type SurfaceDefinitions = {
	[Id in SecondarySurfaceId]: Omit<SurfaceDefinition, 'id'> & { id: Id };
};

const SURFACE_DEFINITIONS = {
	vscode: {
		id: 'vscode',
		label: SURFACE_LABELS.vscode,
		icon: Code2,
		openPath: (notebook) =>
			notebook.source.type === 'git' ? notebook.source.entry_notebook : 'notebook.py',
	},
	opencode: { id: 'opencode', label: SURFACE_LABELS.opencode, icon: Bot },
} satisfies SurfaceDefinitions;

interface OpenMenuProps {
	projectId: string;
	notebookId: string;
	title: string;
	canRunApp: boolean;
	actions: ReturnType<typeof useSurfaceActions>;
	session?: Session | null;
	capabilities?: Capabilities;
	notebook?: NotebookDetail;
	isApp: boolean;
	onOpenFrame: (frame: SecondarySurfaceFrame) => void;
	onCloseFrame: (surfaceId: SecondarySurfaceId, sessionId: string) => void;
}

export function OpenMenu({
	projectId,
	notebookId,
	title,
	canRunApp,
	actions,
	session,
	capabilities,
	notebook,
	isApp,
	onOpenFrame,
	onCloseFrame,
}: OpenMenuProps) {
	const navigate = useNavigate();
	const location = useLocation();
	const controls = (capabilities?.surfaces ?? []).flatMap((capability) => {
		const definition: SurfaceDefinition = SURFACE_DEFINITIONS[capability.id];
		const actionState = actions.states[definition.id];
		const state =
			actionState && actionState.sessionId === session?.session_id
				? actionState.surface
				: session?.surfaces?.[definition.id];
		if (isApp || !session?.can.surfaces?.[definition.id] || session.status !== 'running') {
			return [];
		}
		return [
			{
				...definition,
				capability,
				state,
				canStart: !definition.openPath || !!notebook,
				isStarting: actions.starting.has(definition.id),
				isStopping: actions.stopping.has(definition.id),
			},
		];
	});

	const canOpenApp = canRunApp && !isApp;
	const options: DropdownMenuOption[] = controls.flatMap((control, index) => {
		const SurfaceIcon = control.icon;
		return [
			{
				id: `start:${control.id}`,
				label: control.isStarting
					? `Starting ${control.label}...`
					: control.state?.status === 'ready'
						? `Open ${control.label}`
						: `Start ${control.label}`,
				icon: <SurfaceIcon className="size-3.5" />,
				separatorBefore: index > 0,
				isDisabled: !control.canStart || control.isStarting || control.isStopping,
			},
			...(control.state?.status === 'ready'
				? [
						{
							id: `stop:${control.id}`,
							label: `Stop ${control.label}`,
							icon: <Square className="size-3" />,
							isDisabled: control.isStopping,
							danger: true,
						},
					]
				: []),
		];
	});

	if (canOpenApp)
		options.push({
			id: 'run-app',
			label: 'Run as app',
			icon: <Play className="size-3.5" />,
			separatorBefore: controls.length > 0,
		});
	options.push({
		id: 'static-outputs',
		label: 'View static outputs',
		icon: <Camera className="size-3.5" />,
		separatorBefore: controls.length > 0 && !canOpenApp,
	});

	const start = (control: (typeof controls)[number]) => {
		if (!session) return;
		let open: string | undefined;
		if (control.openPath) {
			if (!notebook) return;
			open = control.openPath(notebook);
		}
		void actions.start
			.mutateAsync({
				surfaceId: control.id,
				sessionId: session.session_id,
				...(open ? { open } : {}),
			})
			.then(
				(surface) => {
					onOpenFrame({
						sessionId: session.session_id,
						surfaceId: control.id,
						label: control.label,
						url: surface.url!,
						embed: control.capability.embed,
					});
				},
				() => null,
			);
	};

	const stop = (control: (typeof controls)[number]) => {
		if (!session) return;
		const sessionId = session.session_id;
		void actions.stop.mutateAsync({ surfaceId: control.id, sessionId }).then(
			() => onCloseFrame(control.id, sessionId),
			() => null,
		);
	};

	const handleAction = (action: string) => {
		const notebookPath = `/projects/${projectId}/notebooks/${notebookId}`;
		if (action === 'static-outputs') {
			void navigate(`${notebookPath}/snapshot`, { state: { title } });
			return;
		}
		if (action === 'run-app') {
			const search = notebookQueryParams(location.search).toString();
			void navigate(`${notebookPath}/app${search ? `?${search}` : ''}`, { state: { title } });
			return;
		}
		const control = controls.find(
			(candidate) => action === `start:${candidate.id}` || action === `stop:${candidate.id}`,
		);
		if (!control) return;
		if (action === `start:${control.id}`) start(control);
		else stop(control);
	};

	return (
		<DropdownMenu label="Open" triggerLabel="Open" options={options} onAction={handleAction} />
	);
}
