import { useState } from 'react';
import { useSelector } from '@tanstack/react-store';
import { ArrowLeft, Blocks, Cloud, ExternalLink, KeyRound } from 'lucide-react';
import { Button, DialogModal } from '@/components/ui';
import { useAppForm, useSeedOnOpen } from '@/components/form';
import { DOCS_FEDERATION_URL } from '@/lib/links';
import type { ProjectDetail } from '@/types';
import { ProjectIntegrationsPanel } from './ProjectIntegrationsDialog';

type Area = 'overview' | 'integrations' | 'cloud';

export interface ProjectEnvironmentDialogProps {
	isOpen: boolean;
	onClose: () => void;
	project: ProjectDetail;
	integrationsAvailable: boolean;
	cloudAccessAvailable: boolean;
	onSaveCloudAccess: (enabled: boolean) => Promise<void>;
	isPending?: boolean;
}

export function ProjectEnvironmentDialog({
	isOpen,
	onClose,
	project,
	integrationsAvailable,
	cloudAccessAvailable,
	onSaveCloudAccess,
	isPending = false,
}: ProjectEnvironmentDialogProps) {
	const [area, setArea] = useState<Area>('overview');
	const close = () => {
		setArea('overview');
		onClose();
	};

	return (
		<DialogModal isOpen={isOpen} onClose={close} title="Environment & access" width="xl">
			{area === 'overview' ? (
				<div className="grid gap-3 sm:grid-cols-2">
					<AreaCard
						icon={Blocks}
						title="Integrations"
						description="Versioned database, catalog, engine, storage, and environment configuration."
						status={integrationsAvailable ? undefined : 'Not configured for this deployment'}
						onPress={() => setArea('integrations')}
					/>
					<AreaCard
						icon={Cloud}
						title="Cloud access"
						description="Short-lived federated credentials, without storing a cloud key."
						status={
							cloudAccessAvailable
								? project.federation?.enabled
									? 'Enabled for this project'
									: 'Disabled for this project'
								: 'Not configured for this deployment'
						}
						onPress={() => setArea('cloud')}
					/>
				</div>
			) : area === 'integrations' ? (
				<ProjectIntegrationsPanel project={project} onBack={() => setArea('overview')} />
			) : (
				<CloudAccessPanel
					isOpen={isOpen}
					project={project}
					available={cloudAccessAvailable}
					onBack={() => setArea('overview')}
					onSave={onSaveCloudAccess}
					isPending={isPending}
				/>
			)}
		</DialogModal>
	);
}

function AreaCard({
	icon: Icon,
	title,
	description,
	status,
	onPress,
}: {
	icon: typeof Blocks;
	title: string;
	description: string;
	status?: string;
	onPress: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onPress}
			className="flex min-h-36 flex-col gap-3 rounded-lg border border-input p-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			<Icon className="size-5 text-primary" aria-hidden />
			<span className="font-semibold">{title}</span>
			<span className="text-sm text-muted-foreground">{description}</span>
			{status && <span className="mt-auto text-xs text-muted-foreground">{status}</span>}
		</button>
	);
}

function CloudAccessPanel({
	isOpen,
	project,
	available,
	onBack,
	onSave,
	isPending,
}: {
	isOpen: boolean;
	project: ProjectDetail;
	available: boolean;
	onBack: () => void;
	onSave: (enabled: boolean) => Promise<void>;
	isPending: boolean;
}) {
	const current = project.federation?.enabled ?? false;
	const canManage = project.your_role === 'admin';
	const form = useAppForm({
		defaultValues: { enabled: current },
		onSubmit: async ({ value }) => {
			try {
				await onSave(value.enabled);
				form.reset({ enabled: value.enabled });
			} catch {
				// The parent reports the mutation error; keep this draft for retry.
			}
		},
	});
	useSeedOnOpen(form, isOpen, { enabled: current });
	const isDirty = useSelector(form.store, (state) => state.isDirty);

	return (
		<div className="flex flex-col gap-4 text-sm">
			<div className="flex items-center gap-3">
				<button
					type="button"
					className="flex items-center gap-1 rounded-sm text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					onClick={onBack}
				>
					<ArrowLeft className="size-3.5" aria-hidden />
					Back
				</button>
				<h3 className="font-semibold">Federated cloud access</h3>
			</div>

			{!available ? (
				<div className="flex flex-col gap-3">
					<p className="text-muted-foreground">
						This deployment has not configured federated cloud access. When configured, notebooks
						can receive short-lived cloud credentials without a stored cloud key.
					</p>
					<a
						href={DOCS_FEDERATION_URL}
						target="_blank"
						rel="noreferrer"
						className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline"
					>
						How to enable it
						<ExternalLink className="size-3.5" />
					</a>
				</div>
			) : !canManage ? (
				<div className="flex items-center gap-2 rounded-md border border-input p-3">
					<KeyRound className="size-4" aria-hidden />
					Federated cloud access is {current ? 'enabled' : 'disabled'}.
				</div>
			) : (
				<form
					className="flex flex-col gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						void form.handleSubmit();
					}}
				>
					<p className="text-muted-foreground">
						Sessions receive short-lived credentials as standard cloud environment variables.
					</p>
					<form.AppField name="enabled">
						{(field) => (
							<field.SwitchField>
								{(selected) => (
									<span className="flex items-center gap-1.5 text-sm font-medium">
										<KeyRound className="size-4" />
										Federated cloud access {selected ? 'enabled' : 'disabled'}
									</span>
								)}
							</field.SwitchField>
						)}
					</form.AppField>
					<div className="flex justify-end">
						<Button type="submit" variant="primary" isDisabled={isPending || !isDirty}>
							{isPending ? 'Saving…' : 'Save'}
						</Button>
					</div>
				</form>
			)}
		</div>
	);
}
