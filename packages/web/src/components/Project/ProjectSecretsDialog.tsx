import { toast } from 'sonner';
import { useSelector } from '@tanstack/react-store';
import { ExternalLink, KeyRound, Plus, Trash2 } from 'lucide-react';
import { Button, ConfirmDialog, DialogModal, IconButton } from '@/components/ui';
import { useAppForm, useSeedOnOpen } from '@/components/form';
import {
	useDeleteSecret,
	useProjectSecretsQuery,
	usePutSecret,
	useValidateSecret,
} from '@/api/hooks';
import { useDialogTarget } from '@/hooks/useDialogTarget';
import { toastError } from '@/lib/errors';
import { DOCS_FEDERATION_URL } from '@/lib/links';
import type { ProjectDetail, SecretEntry } from '@/types';

// Mirrors the server's `assertValidSecretName` for instant feedback; the server
// remains authoritative (it also rejects reserved names/prefixes).
const SECRET_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

interface AddSecretForm {
	name: string;
	backend: string;
	locator: string;
	expand: boolean;
	prefix: string;
}

function referenceInput(name: string, v: AddSecretForm) {
	return {
		name,
		backend: v.backend.trim(),
		locator: v.locator.trim(),
		expand: v.expand ? ('json' as const) : undefined,
		prefix: v.expand ? v.prefix.trim() || undefined : undefined,
	};
}

export interface ProjectSecretsDialogProps {
	isOpen: boolean;
	onClose: () => void;
	project: ProjectDetail;
	/** Whether the deployment has Workload Identity Federation configured. */
	available: boolean;
	onSave: (enabled: boolean) => void;
	isPending?: boolean;
}

/**
 * A project's secrets: the federated-bucket-access toggle (short-lived cloud
 * credentials, no stored key), plus — when the deployment enables the secrets
 * store — the third-party keys injected into every session as env vars.
 */
export function ProjectSecretsDialog({
	isOpen,
	onClose,
	project,
	available,
	onSave,
	isPending = false,
}: ProjectSecretsDialogProps) {
	return (
		<DialogModal isOpen={isOpen} onClose={onClose} title="Project secrets" width="md">
			<div className="flex flex-col gap-6 text-sm">
				<FederatedAccessSection
					isOpen={isOpen}
					available={available}
					current={project.federation?.enabled ?? false}
					onSave={onSave}
					isPending={isPending}
				/>
				<StoredKeysSection project={project} isOpen={isOpen} />
			</div>
		</DialogModal>
	);
}

interface FederatedAccessSectionProps {
	isOpen: boolean;
	available: boolean;
	current: boolean;
	onSave: (enabled: boolean) => void;
	isPending: boolean;
}

function FederatedAccessSection({
	isOpen,
	available,
	current,
	onSave,
	isPending,
}: FederatedAccessSectionProps) {
	const form = useAppForm({
		defaultValues: { enabled: current },
		onSubmit: ({ value }) => onSave(value.enabled),
	});
	// Re-seed to the persisted value each open so a cancelled edit doesn't leak.
	useSeedOnOpen(form, isOpen, { enabled: current });
	const isDirty = useSelector(form.store, (s) => s.isDirty);

	if (!available) {
		return (
			<section className="flex flex-col gap-3">
				<h3 className="font-semibold">Federated bucket access</h3>
				<p className="text-muted-foreground">
					Give this project's notebooks short-lived, auto-expiring credentials for a cloud bucket —
					no long-lived keys stored anywhere. This deployment hasn't enabled it yet.
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
			</section>
		);
	}

	return (
		<form
			className="flex flex-col gap-3"
			onSubmit={(e) => {
				e.preventDefault();
				void form.handleSubmit();
			}}
		>
			<h3 className="font-semibold">Federated bucket access</h3>
			<p className="text-muted-foreground">
				When enabled, sessions in this project receive short-lived bucket credentials as standard{' '}
				<code className="text-xs">AWS_*</code> environment variables.
			</p>
			<form.AppField name="enabled">
				{(f) => (
					<f.SwitchField>
						{(isSelected) => (
							<span className="flex items-center gap-1.5 text-sm font-medium">
								<KeyRound className="size-4" />
								Federated bucket access {isSelected ? 'enabled' : 'disabled'}
							</span>
						)}
					</f.SwitchField>
				)}
			</form.AppField>
			<div className="flex justify-end">
				<Button type="submit" variant="primary" isDisabled={isPending || !isDirty}>
					{isPending ? 'Saving...' : 'Save'}
				</Button>
			</div>
		</form>
	);
}

function StoredKeysSection({ project, isOpen }: { project: ProjectDetail; isOpen: boolean }) {
	const { data: secrets } = useProjectSecretsQuery(project.id, isOpen);
	const putSecret = usePutSecret(project.id);
	const deleteSecret = useDeleteSecret(project.id);
	const isAdmin = project.your_role === 'admin';
	const confirmDelete = useDialogTarget<SecretEntry>();

	const validateSecret = useValidateSecret(project.id);

	const form = useAppForm({
		defaultValues: { name: '', backend: 'aws-sm', locator: '', expand: false, prefix: '' },
		onSubmit: async ({ value }) => {
			const name = value.name.trim();
			if (!SECRET_NAME_RE.test(name)) {
				toast.error('Name must be UPPER_SNAKE_CASE (letters, digits, underscores).');
				return;
			}
			try {
				await putSecret.mutateAsync(referenceInput(name, value));
				toast.success('Secret saved');
				form.reset();
			} catch (err) {
				toastError(err);
			}
		},
	});

	// Dry-run the reference so a broken locator surfaces before it fails a session.
	const handleTest = async () => {
		const v = form.state.values;
		try {
			const res = await validateSecret.mutateAsync(referenceInput(v.name.trim() || 'TEST', v));
			if (res.ok) toast.success('Reference resolves');
			else toast.error(res.reason ?? 'Reference did not resolve');
		} catch (err) {
			toastError(err);
		}
	};

	const handleRemove = () => {
		const target = confirmDelete.target;
		if (!target) return;
		deleteSecret.mutate(target.name, {
			onSuccess: () => {
				toast.success('Secret deleted');
				confirmDelete.close();
			},
			onError: toastError,
		});
	};

	// Hidden until the list resolves; `null` = the deployment disabled the feature.
	if (!Array.isArray(secrets)) return null;

	return (
		<section className="flex flex-col gap-3 border-t pt-5">
			<div className="flex flex-col gap-1">
				<h3 className="font-semibold">Stored keys</h3>
				<p className="text-muted-foreground">
					Third-party keys injected into every session as environment variables. A reference points
					at a secret in your external manager; the value is fetched at launch and never stored
					here.
				</p>
			</div>

			{secrets.length === 0 ? (
				<p className="text-muted-foreground">No keys yet.</p>
			) : (
				<ul className="flex flex-col divide-y">
					{secrets.map((entry) => (
						<li
							key={entry.name}
							data-testid="secret-row"
							className="flex items-center justify-between gap-3 py-2"
						>
							<span className="flex min-w-0 flex-col">
								<code className="truncate text-xs font-medium">
									{entry.name}
									{entry.ref?.expand === 'json' && (
										<span className="ml-1.5 font-sans text-muted-foreground">
											· expands JSON{entry.ref.prefix ? ` (${entry.ref.prefix}*)` : ''}
										</span>
									)}
								</code>
								{entry.ref && (
									<span className="truncate text-xs text-muted-foreground">
										{entry.ref.backend} · {entry.ref.locator}
									</span>
								)}
							</span>
							{isAdmin && (
								<IconButton
									label={`Delete ${entry.name}`}
									tooltip="Delete secret"
									tone="danger"
									onPress={() => confirmDelete.open(entry)}
								>
									<Trash2 className="size-4" />
								</IconButton>
							)}
						</li>
					))}
				</ul>
			)}

			{isAdmin && (
				<form
					onSubmit={(e) => {
						e.preventDefault();
						void form.handleSubmit();
					}}
					className="flex flex-col gap-3 border-t pt-4"
				>
					<span className="text-xs font-semibold">Add a reference</span>
					<form.AppField name="name">
						{(f) => <f.TextField label="Env var name" placeholder="OPENAI_API_KEY" />}
					</form.AppField>
					<div className="flex gap-2">
						<div className="w-32 shrink-0">
							<form.AppField name="backend">
								{(f) => <f.TextField label="Backend" placeholder="aws-sm" />}
							</form.AppField>
						</div>
						<div className="flex-1">
							<form.AppField name="locator">
								{(f) => <f.TextField label="Locator" placeholder="prod/ai#OPENAI_API_KEY" />}
							</form.AppField>
						</div>
					</div>
					<form.AppField name="expand">
						{(f) => (
							<f.SwitchField>
								{(on) => (
									<span className="text-sm font-medium">
										Expand JSON into one env var per key {on ? '(on)' : ''}
									</span>
								)}
							</f.SwitchField>
						)}
					</form.AppField>
					<form.Subscribe selector={(s) => s.values.expand}>
						{(expand) =>
							expand ? (
								<form.AppField name="prefix">
									{(f) => <f.TextField label="Key prefix (optional)" placeholder="APP_" />}
								</form.AppField>
							) : null
						}
					</form.Subscribe>
					<div className="flex justify-end gap-2">
						<Button
							type="button"
							variant="ghost"
							isDisabled={validateSecret.isPending}
							onPress={() => void handleTest()}
						>
							{validateSecret.isPending ? 'Testing...' : 'Test'}
						</Button>
						<Button type="submit" variant="primary" isDisabled={putSecret.isPending}>
							<Plus className="size-4" />
							{putSecret.isPending ? 'Saving...' : 'Add secret'}
						</Button>
					</div>
				</form>
			)}

			<ConfirmDialog
				isOpen={confirmDelete.isOpen}
				onClose={confirmDelete.close}
				title="Delete secret"
				description={`Delete "${confirmDelete.target?.name}"? Sessions in this project will no longer receive it.`}
				confirmLabel="Delete"
				pendingLabel="Deleting..."
				isPending={deleteSecret.isPending}
				onConfirm={handleRemove}
			/>
		</section>
	);
}
