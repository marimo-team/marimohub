import { useSelector } from '@tanstack/react-store';
import { ExternalLink, KeyRound } from 'lucide-react';
import { Button, DialogModal } from '@/components/ui';
import { useAppForm, useSeedOnOpen } from '@/components/form';
import { DOCS_FEDERATION_URL } from '@/lib/links';
import { canManageProject } from '@/lib/roles';
import type { ProjectDetail } from '@/types';

type EffectiveFederation = ProjectDetail['federation_effective'];

export type CloudAccessSetting = 'inherit' | 'enabled' | 'disabled';

export interface ProjectCloudAccessDialogProps {
	isOpen: boolean;
	onClose: () => void;
	project: ProjectDetail;
	cloudAccessLoading: boolean;
	cloudAccessAvailable: boolean;
	cloudAccessDefaultEnabled: boolean;
	onSaveCloudAccess: (setting: CloudAccessSetting) => Promise<void>;
	isPending?: boolean;
}

export function ProjectCloudAccessDialog({
	isOpen,
	onClose,
	project,
	cloudAccessLoading,
	cloudAccessAvailable,
	cloudAccessDefaultEnabled,
	onSaveCloudAccess,
	isPending = false,
}: ProjectCloudAccessDialogProps) {
	const federation = resolveCloudAccess(project);
	return (
		<DialogModal isOpen={isOpen} onClose={onClose} title="Cloud access" width="lg">
			{cloudAccessLoading ? (
				<output>Loading cloud access…</output>
			) : (
				<CloudAccessPanel
					isOpen={isOpen}
					project={project}
					federation={federation}
					available={cloudAccessAvailable && federation.source !== 'unavailable'}
					defaultEnabled={cloudAccessDefaultEnabled}
					onSave={onSaveCloudAccess}
					isPending={isPending}
				/>
			)}
		</DialogModal>
	);
}

function resolveCloudAccess(
	project: Pick<ProjectDetail, 'federation_effective'>,
): EffectiveFederation {
	// Capabilities and saved overrides cannot replace the server's effective resolution.
	return project.federation_effective ?? { enabled: false, source: 'unavailable' };
}

function cloudAccessSetting({ enabled, source }: EffectiveFederation): CloudAccessSetting {
	if (source !== 'project') return 'inherit';
	return enabled ? 'enabled' : 'disabled';
}

function effectiveCloudAccessLabel({ enabled, source }: EffectiveFederation): string {
	if (source === 'unavailable') return 'Not configured for this deployment';
	return `${enabled ? 'Enabled' : 'Disabled'} ${source === 'deployment' ? 'by deployment default' : 'for this project'}`;
}

function CloudAccessPanel({
	isOpen,
	project,
	federation,
	available,
	defaultEnabled,
	onSave,
	isPending,
}: {
	isOpen: boolean;
	project: ProjectDetail;
	federation: EffectiveFederation;
	available: boolean;
	defaultEnabled: boolean;
	onSave: (setting: CloudAccessSetting) => Promise<void>;
	isPending: boolean;
}) {
	const setting = cloudAccessSetting(federation);
	const canManage = canManageProject(project.your_role);
	const form = useAppForm({
		defaultValues: { setting },
		onSubmit: async ({ value }) => {
			try {
				await onSave(value.setting);
				form.reset({ setting: value.setting });
			} catch {
				// Keep the draft for retry; the global mutation handler reports the error.
			}
		},
	});
	useSeedOnOpen(form, isOpen, { setting });
	const isDirty = useSelector(form.store, (state) => state.isDirty);

	return (
		<div className="flex flex-col gap-4 text-sm">
			<h3 className="font-semibold">Federated cloud access</h3>

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
					Federated cloud access is {effectiveCloudAccessLabel(federation).toLowerCase()}.
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
					<form.AppField name="setting">
						{(field) => (
							<field.RadioGroupField
								label="Federated cloud access"
								options={[
									{
										value: 'inherit',
										label: 'Use deployment default',
										description: defaultEnabled ? 'Currently enabled' : 'Currently disabled',
									},
									{ value: 'enabled', label: 'Enabled' },
									{ value: 'disabled', label: 'Disabled' },
								]}
								isDisabled={isPending}
							/>
						)}
					</form.AppField>
					<p className="text-muted-foreground">
						Changes apply to new sessions and jobs. Restart running kernels to use the new setting.
					</p>
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
