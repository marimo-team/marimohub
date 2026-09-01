import { Bot, ChevronDown, Code2, Square } from 'lucide-react';
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

interface SurfaceMenuProps {
	actions: ReturnType<typeof useSurfaceActions>;
	session?: Session | null;
	capabilities?: Capabilities;
	notebook?: NotebookDetail;
	isApp: boolean;
	onOpenFrame: (frame: SecondarySurfaceFrame) => void;
	onCloseFrame: (surfaceId: SecondarySurfaceId, sessionId: string) => void;
}

export function SurfaceMenu({
	actions,
	session,
	capabilities,
	notebook,
	isApp,
	onOpenFrame,
	onCloseFrame,
}: SurfaceMenuProps) {
	const controls = (capabilities?.surfaces ?? [])
		.map((capability) => {
			const definition: SurfaceDefinition = SURFACE_DEFINITIONS[capability.id];
			const actionState = actions.states[definition.id];
			const state =
				actionState && actionState.sessionId === session?.session_id
					? actionState.surface
					: session?.surfaces?.[definition.id];
			return {
				...definition,
				capability,
				state,
				canStart: !definition.openPath || !!notebook,
				isStarting: actions.starting.has(definition.id),
				isStopping: actions.stopping.has(definition.id),
			};
		})
		.filter(
			(control) => !isApp && !!session?.can.surfaces?.[control.id] && session.status === 'running',
		);

	if (controls.length === 0) return null;

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
		const control = controls.find(
			(candidate) => action === `start:${candidate.id}` || action === `stop:${candidate.id}`,
		);
		if (!control) return;
		if (action === `start:${control.id}`) start(control);
		else stop(control);
	};

	return (
		<DropdownMenu
			label="Surfaces"
			icon={
				<>
					<Code2 className="size-3" />
					<span>Surfaces</span>
					<ChevronDown className="size-3" />
				</>
			}
			triggerClassName="h-[26px] w-auto gap-1 rounded-md border border-input px-2 text-xs hover:border-primary hover:bg-transparent hover:text-primary max-md:h-11"
			options={options}
			onAction={handleAction}
		/>
	);
}
