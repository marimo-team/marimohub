import { useState } from 'react';
import { Bell, CheckCircle2, Pencil, Plus, Send, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
	useCreateProjectAlert,
	useDeleteProjectAlert,
	useProjectAlertsQuery,
	useTestProjectAlert,
	useUpdateProjectAlert,
} from '@/api/hooks';
import { Button, ConfirmDialog, DialogModal, EmptyState, TextField } from '@/components/ui';
import { useDialogTarget } from '@/hooks/useDialogTarget';
import { toastError } from '@/lib/errors';
import type { ProjectAlertDestination, ProjectAlertKind } from '@/types';

const LABELS: Record<ProjectAlertKind, string> = {
	'member.invited': 'Member invited',
	'member.added': 'Member added',
	'member.role_changed': 'Member role changed',
	'member.removed': 'Member removed',
	'session.takeover': 'Editor takeover',
	'notebook.deleted': 'Notebook deleted',
	'project.deleted': 'Project deleted',
	'app.start_failed': 'App start failed',
	'app.unavailable': 'App unavailable',
	'sync.failed': 'Git sync failed',
};

const GROUPS: { label: string; kinds: ProjectAlertKind[] }[] = [
	{
		label: 'Access',
		kinds: ['member.invited', 'member.added', 'member.role_changed', 'member.removed'],
	},
	{ label: 'Content', kinds: ['session.takeover', 'notebook.deleted', 'project.deleted'] },
	{ label: 'Runtime', kinds: ['app.start_failed', 'app.unavailable', 'sync.failed'] },
];

interface Props {
	isOpen: boolean;
	onClose: () => void;
	projectId: string;
	selectableKinds: ProjectAlertKind[];
	maxDestinations: number;
}

type EditorState = {
	destination?: ProjectAlertDestination;
	type: 'slack' | 'webhook';
	name: string;
	kinds: ProjectAlertKind[];
	endpoint: string;
	secret: string;
};

function fresh(kinds: ProjectAlertKind[]): EditorState {
	return { type: 'slack', name: '', kinds: [...kinds], endpoint: '', secret: '' };
}

export function ProjectAlertsDialog({
	isOpen,
	onClose,
	projectId,
	selectableKinds,
	maxDestinations,
}: Props) {
	const { data: destinations = [], isLoading } = useProjectAlertsQuery(projectId, isOpen);
	const create = useCreateProjectAlert(projectId);
	const update = useUpdateProjectAlert(projectId);
	const remove = useDeleteProjectAlert(projectId);
	const test = useTestProjectAlert(projectId);
	const confirmDelete = useDialogTarget<ProjectAlertDestination>();
	const [editor, setEditor] = useState<EditorState | null>(null);
	const pending = create.isPending || update.isPending;

	const edit = (destination: ProjectAlertDestination) =>
		setEditor({
			destination,
			type: destination.type,
			name: destination.name,
			kinds: [...destination.kinds],
			endpoint: '',
			secret: '',
		});

	const save = async () => {
		if (!editor?.name.trim() || editor.kinds.length === 0) return;
		try {
			if (!editor.destination) {
				if (!editor.endpoint.trim() || (editor.type === 'webhook' && !editor.secret)) return;
				await create.mutateAsync(
					editor.type === 'slack'
						? {
								name: editor.name.trim(),
								type: 'slack',
								kinds: editor.kinds,
								webhook_url: editor.endpoint.trim(),
							}
						: {
								name: editor.name.trim(),
								type: 'webhook',
								kinds: editor.kinds,
								url: editor.endpoint.trim(),
								signing_secret: editor.secret,
							},
				);
				toast.success('Alert destination created. Send a test before enabling it.');
			} else {
				await update.mutateAsync({
					id: editor.destination.id,
					updatedAt: editor.destination.updated_at,
					name: editor.name.trim(),
					kinds: editor.kinds,
					...(editor.type === 'slack' && editor.endpoint.trim()
						? { webhook_url: editor.endpoint.trim() }
						: {}),
					...(editor.type === 'webhook' && editor.endpoint.trim()
						? { url: editor.endpoint.trim() }
						: {}),
					...(editor.type === 'webhook' && editor.secret ? { signing_secret: editor.secret } : {}),
				});
				toast.success('Alert destination updated.');
			}
			setEditor(null);
		} catch (error) {
			toastError(error);
		}
	};

	const deleteDestination = async () => {
		const destination = confirmDelete.target;
		if (!destination) return;
		try {
			await remove.mutateAsync({ id: destination.id, updatedAt: destination.updated_at });
			toast.success('Alert destination deleted.');
			confirmDelete.close();
		} catch (error) {
			toastError(error);
		}
	};

	return (
		<DialogModal isOpen={isOpen} onClose={onClose} title="Project alerts" width="lg">
			<div className="space-y-5">
				<div className="flex items-start justify-between gap-4">
					<p className="max-w-xl text-sm text-muted-foreground">
						Send selected project events to Slack or a signed HTTPS webhook. Destinations stay
						disabled until a test succeeds.
					</p>
					<Button
						size="sm"
						onPress={() => setEditor(fresh(selectableKinds))}
						isDisabled={destinations.length >= maxDestinations}
					>
						<Plus className="size-3.5" /> Add destination
					</Button>
				</div>

				{editor && (
					<div className="space-y-4 rounded-lg border bg-muted/20 p-4">
						<div className="flex items-center justify-between">
							<h3 className="text-sm font-semibold">
								{editor.destination ? 'Edit destination' : 'New destination'}
							</h3>
							{!editor.destination && (
								<select
									aria-label="Destination type"
									value={editor.type}
									onChange={(event) =>
										setEditor({ ...editor, type: event.target.value as 'slack' | 'webhook' })
									}
									className="h-9 rounded-md border bg-background px-3 text-sm"
								>
									<option value="slack">Slack</option>
									<option value="webhook">Signed webhook</option>
								</select>
							)}
						</div>
						<TextField
							label="Name"
							value={editor.name}
							onChange={(value) => setEditor({ ...editor, name: value })}
							placeholder="Engineering alerts"
						/>
						<TextField
							label={editor.type === 'slack' ? 'Slack incoming webhook URL' : 'Webhook URL'}
							value={editor.endpoint}
							onChange={(value) => setEditor({ ...editor, endpoint: value })}
							placeholder={
								editor.destination
									? `Configured for ${editor.destination.endpoint_host}; leave blank to keep it`
									: 'https://…'
							}
						/>
						{editor.type === 'webhook' && (
							<TextField
								label="HMAC signing secret"
								type="password"
								value={editor.secret}
								onChange={(value) => setEditor({ ...editor, secret: value })}
								placeholder={editor.destination ? 'Leave blank to keep the stored secret' : ''}
							/>
						)}
						<div className="grid gap-4 sm:grid-cols-3">
							{GROUPS.map((group) => (
								<fieldset key={group.label} className="space-y-2">
									<legend className="text-xs font-semibold text-muted-foreground">
										{group.label}
									</legend>
									{group.kinds
										.filter((kind) => selectableKinds.includes(kind))
										.map((kind) => (
											<label key={kind} className="flex items-center gap-2 text-xs">
												<input
													type="checkbox"
													aria-label={LABELS[kind]}
													checked={editor.kinds.includes(kind)}
													onChange={(event) =>
														setEditor({
															...editor,
															kinds: event.target.checked
																? [...editor.kinds, kind]
																: editor.kinds.filter((value) => value !== kind),
														})
													}
												/>
												{LABELS[kind]}
											</label>
										))}
								</fieldset>
							))}
						</div>
						<div className="flex justify-end gap-2">
							<Button size="sm" variant="ghost" onPress={() => setEditor(null)}>
								Cancel
							</Button>
							<Button
								size="sm"
								variant="primary"
								onPress={() => void save()}
								isDisabled={
									pending ||
									!editor.name.trim() ||
									editor.kinds.length === 0 ||
									(!editor.destination &&
										(!editor.endpoint.trim() || (editor.type === 'webhook' && !editor.secret)))
								}
							>
								{pending ? 'Saving…' : 'Save'}
							</Button>
						</div>
					</div>
				)}

				{isLoading ? (
					<p className="text-sm text-muted-foreground">Loading destinations…</p>
				) : destinations.length === 0 ? (
					<EmptyState
						icon={<Bell className="size-5" />}
						message="No alert destinations"
						description="Add Slack or a signed webhook destination for this project."
					/>
				) : (
					<div className="divide-y rounded-lg border">
						{destinations.map((destination) => (
							<div key={destination.id} className="flex items-center gap-3 p-3">
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<span className="truncate text-sm font-medium">{destination.name}</span>
										<span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase">
											{destination.type}
										</span>
										{destination.verified_at && (
											<CheckCircle2 className="size-3.5 text-emerald-600" aria-label="Verified" />
										)}
									</div>
									<p className="truncate text-xs text-muted-foreground">
										{destination.endpoint_host} · {destination.kinds.length} events ·{' '}
										{destination.enabled ? 'enabled' : 'disabled'}
									</p>
								</div>
								<Button
									size="sm"
									onPress={() =>
										test.mutate(
											{
												id: destination.id,
												updatedAt: destination.updated_at,
											},
											{
												onSuccess: () => toast.success('Test alert delivered.'),
												onError: toastError,
											},
										)
									}
									isDisabled={test.isPending}
								>
									<Send className="size-3.5" /> Test
								</Button>
								<Button
									size="sm"
									onPress={() =>
										update.mutate(
											{
												id: destination.id,
												updatedAt: destination.updated_at,
												enabled: !destination.enabled,
											},
											{ onError: toastError },
										)
									}
									isDisabled={!destination.verified_at || update.isPending}
								>
									{destination.enabled ? 'Disable' : 'Enable'}
								</Button>
								<Button
									size="sm"
									variant="ghost"
									aria-label={`Edit ${destination.name}`}
									onPress={() => edit(destination)}
								>
									<Pencil className="size-3.5" />
								</Button>
								<Button
									size="sm"
									variant="ghost"
									aria-label={`Delete ${destination.name}`}
									onPress={() => confirmDelete.open(destination)}
								>
									<Trash2 className="size-3.5 text-destructive" />
								</Button>
							</div>
						))}
					</div>
				)}
			</div>
			<ConfirmDialog
				isOpen={confirmDelete.isOpen}
				onClose={confirmDelete.close}
				title="Delete alert destination"
				description={`Delete "${confirmDelete.target?.name}"? Its stored endpoint and secret cannot be recovered.`}
				confirmLabel="Delete"
				pendingLabel="Deleting…"
				isPending={remove.isPending}
				onConfirm={() => void deleteDestination()}
			/>
		</DialogModal>
	);
}
