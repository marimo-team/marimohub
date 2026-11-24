import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DeepLinkSlugSchema } from '@marimo-hub/core/deep-link-slug';
import { Copy, Globe, Lock, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
	useDeepLinksQuery,
	useRegisterDeepLink,
	useReleaseDeepLink,
	useUpdateDeepLinkAccess,
} from '@/api/deepLinks';
import {
	projectQueryOptions,
	useCapabilitiesQuery,
	useIntegrationsQuery,
	useNotebookQuery,
} from '@/api/hooks';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { DialogModal } from '@/components/ui/Dialog';
import { IconButton } from '@/components/ui/IconButton';
import { TextField } from '@/components/ui/TextField';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { withBasePath } from '@/lib/basePath';
import { shareableNotebookQuery } from '@/lib/notebookUrls';

interface AppLinksDialogProps {
	projectId: string;
	notebookId: string;
	canManage: boolean;
	search?: string;
	onClose: () => void;
}

type PendingToggle =
	| { kind: 'enable'; slug: string; registration_id: string }
	| { kind: 'disable'; slug: string; registration_id: string };

export function AppLinksDialog({
	projectId,
	notebookId,
	canManage,
	search = '',
	onClose,
}: AppLinksDialogProps) {
	const query = shareableNotebookQuery(search).toString();
	const pathFor = (slug: string) => withBasePath(`/app/${slug}${query ? `?${query}` : ''}`);
	const urlFor = (slug: string) => new URL(pathFor(slug), window.location.origin).toString();
	const links = useDeepLinksQuery(projectId, notebookId);
	const currentLinks = links.isFetchedAfterMount && !links.isError ? links.data : undefined;
	const register = useRegisterDeepLink(projectId, notebookId);
	const release = useReleaseDeepLink(projectId, notebookId);
	const updateAccess = useUpdateDeepLinkAccess(projectId, notebookId);
	const { data: capabilities } = useCapabilitiesQuery();
	const publicLinksAvailable = Boolean(capabilities?.public_app_links?.available);
	const allowIntegrationsOptIn = Boolean(
		capabilities?.public_app_links?.allow_project_integrations,
	);
	const projectQuery = useQuery({
		...projectQueryOptions(projectId),
		enabled: canManage && publicLinksAvailable,
	});
	const notebookQuery = useNotebookQuery(projectId, notebookId, {
		enabled: canManage && publicLinksAvailable,
	});
	const integrationsQuery = useIntegrationsQuery(
		{ pid: projectId },
		canManage && publicLinksAvailable && allowIntegrationsOptIn,
	);
	const projectIntegrations = (integrationsQuery.data ?? []).filter(
		(entry) => entry.scope === 'project' && entry.enabled,
	);
	const hasSecurityLabels = Boolean(
		projectQuery.data?.security_labels || notebookQuery.data?.meta.security_labels,
	);

	const { copy } = useCopyToClipboard();
	const [slug, setSlug] = useState('');
	const [pendingToggle, setPendingToggle] = useState<PendingToggle | null>(null);
	const [includeProjectIntegrations, setIncludeProjectIntegrations] = useState(false);
	const canonicalSlug = slug.trim().toLowerCase();
	const valid = DeepLinkSlugSchema.safeParse(canonicalSlug).success;
	const pending = register.isPending || release.isPending || updateAccess.isPending;

	return (
		<>
			<DialogModal isOpen onClose={onClose} title="App links" width="lg">
				<div className="flex flex-col gap-4">
					<p className="text-sm text-muted-foreground">
						{publicLinksAvailable
							? 'App links use the notebook’s existing permissions by default. Managers can optionally make individual links publicly accessible without sign-in.'
							: 'App links use the notebook’s existing permissions. People must sign in and have permission to run the app.'}
					</p>
					{!links.isError && !links.isFetchedAfterMount && (
						<output className="text-sm">Loading links…</output>
					)}
					{links.isError && (
						<div role="alert" className="text-sm text-destructive">
							{links.error.message}{' '}
							<Button variant="ghost" onPress={() => void links.refetch()}>
								Try again
							</Button>
						</div>
					)}
					{currentLinks?.length === 0 && (
						<p className="text-sm text-muted-foreground">No app links yet.</p>
					)}
					<ul className="flex flex-col gap-2">
						{currentLinks?.map((link) => {
							const isPublic = link.access?.mode === 'public';
							const usesProjectIntegrations = Boolean(link.access?.allow_project_integrations);
							return (
								<li
									key={link.registration_id}
									className="flex flex-col gap-2 rounded-md border p-2.5"
								>
									<div className="flex items-center gap-2">
										<div className="min-w-0 flex-1">
											<a
												href={pathFor(link.slug)}
												className="block break-all text-sm text-primary underline"
											>
												{urlFor(link.slug)}
											</a>
											<div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
												<span
													className={
														isPublic
															? 'inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 font-medium text-emerald-700 dark:text-emerald-300'
															: 'inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground'
													}
												>
													{isPublic ? (
														<>
															<Globe className="size-3" /> Public
														</>
													) : (
														<>
															<Lock className="size-3" /> Private
														</>
													)}
												</span>
												{isPublic && usesProjectIntegrations && (
													<span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 font-medium text-amber-700 dark:text-amber-300">
														Project integrations
													</span>
												)}
											</div>
										</div>
										{canManage && (publicLinksAvailable || isPublic) && (
											<Button
												variant="ghost"
												size="sm"
												isDisabled={pending || (!isPublic && hasSecurityLabels)}
												onPress={() => {
													updateAccess.reset();
													setIncludeProjectIntegrations(false);
													setPendingToggle({
														kind: isPublic ? 'disable' : 'enable',
														slug: link.slug,
														registration_id: link.registration_id,
													});
												}}
											>
												{isPublic ? 'Make private' : 'Make public'}
											</Button>
										)}
										<IconButton
											label={`Copy ${link.slug}`}
											onPress={() =>
												void copy(urlFor(link.slug)).then(
													(copied) => copied && toast.success('App link copied'),
												)
											}
										>
											<Copy className="size-4" />
										</IconButton>
										{canManage && (
											<IconButton
												label={`Remove ${link.slug}`}
												isDisabled={pending}
												onPress={() =>
													release.mutate(link, {
														onSuccess: () => toast.success('App link removed'),
													})
												}
											>
												<Trash2 className="size-4" />
											</IconButton>
										)}
									</div>
								</li>
							);
						})}
					</ul>
					{canManage && publicLinksAvailable && hasSecurityLabels && (
						<p className="text-xs text-muted-foreground">
							Public access is unavailable while this project or notebook has security labels.
						</p>
					)}
					{updateAccess.isError && (
						<p role="alert" className="text-sm text-destructive">
							{updateAccess.error.message}
						</p>
					)}
					{canManage && (
						<>
							<p className="text-xs text-muted-foreground">
								Removing a link makes its name available immediately. Old shared URLs may then open
								another app. Authenticated sessions and notebook permissions are unaffected.
							</p>
							<form
								className="flex flex-col gap-3 border-t pt-4"
								onSubmit={(event) => {
									event.preventDefault();
									if (!valid || pending) return;
									register.mutate(canonicalSlug, {
										onSuccess: () => {
											setSlug('');
											toast.success('App link created');
										},
									});
								}}
							>
								<TextField
									label="App slug"
									value={slug}
									onChange={(value) => {
										setSlug(value);
										register.reset();
									}}
									placeholder="team/overview"
									maxLength={63}
									isDisabled={pending}
								/>
								<p className="text-xs text-muted-foreground">
									Use letters, digits, and hyphens, with / between segments. Start and end each
									segment with a letter or digit. Maximum 63 characters. Names are shared across
									this hub.
								</p>
								{valid && (
									<p className="break-all text-xs text-muted-foreground">{urlFor(canonicalSlug)}</p>
								)}
								{register.isError && (
									<p role="alert" className="text-sm text-destructive">
										{register.error.message}
									</p>
								)}
								<Button type="submit" isDisabled={!valid || pending}>
									{register.isPending ? 'Creating…' : 'Create app link'}
								</Button>
							</form>
						</>
					)}
				</div>
			</DialogModal>

			<ConfirmDialog
				isOpen={pendingToggle?.kind === 'enable'}
				onClose={() => setPendingToggle(null)}
				title="Make app link public?"
				variant="primary"
				confirmLabel="Make public"
				pendingLabel="Publishing…"
				isPending={updateAccess.isPending}
				description={
					<>
						Anyone with <strong>{pendingToggle ? urlFor(pendingToggle.slug) : ''}</strong> will be
						able to open and interact with this app without signing in. Source code, edit mode,
						cloud WIF credentials, org integrations, and the rest of marimohub stay inaccessible.
					</>
				}
				onConfirm={() => {
					if (!pendingToggle || pendingToggle.kind !== 'enable') return;
					updateAccess.mutate(
						{
							slug: pendingToggle.slug,
							registration_id: pendingToggle.registration_id,
							access: {
								mode: 'public',
								...(allowIntegrationsOptIn && includeProjectIntegrations
									? { allow_project_integrations: true }
									: {}),
							},
						},
						{
							onSuccess: () => {
								setPendingToggle(null);
								toast.success('App link is now public');
							},
							onError: () => {
								setPendingToggle(null);
							},
						},
					);
				}}
			>
				{allowIntegrationsOptIn && (
					<div className="flex flex-col gap-2 rounded-md border p-3 text-sm">
						<div className="flex items-start gap-2">
							<input
								id="public-app-include-integrations"
								aria-labelledby="public-app-include-integrations-label"
								type="checkbox"
								className="mt-1"
								checked={includeProjectIntegrations}
								onChange={(event) => setIncludeProjectIntegrations(event.target.checked)}
							/>
							<label
								id="public-app-include-integrations-label"
								htmlFor="public-app-include-integrations"
								className="cursor-pointer"
							>
								<span className="font-medium text-foreground">
									Include this project’s integrations
								</span>
								<span className="mt-0.5 block text-xs text-muted-foreground">
									Allows the public app to use enabled project-scoped integrations (such as
									databases or custom environment variables). Use read-only credentials.
								</span>
							</label>
						</div>
						{projectIntegrations.length > 0 ? (
							<ul className="ml-6 list-disc text-xs text-muted-foreground">
								{projectIntegrations.map((entry) => (
									<li key={entry.id}>
										{entry.name} ({entry.kind})
									</li>
								))}
							</ul>
						) : (
							<p className="ml-6 text-xs text-muted-foreground">
								No enabled project-scoped integrations configured.
							</p>
						)}
					</div>
				)}
			</ConfirmDialog>

			<ConfirmDialog
				isOpen={pendingToggle?.kind === 'disable'}
				onClose={() => setPendingToggle(null)}
				title="Turn off public access?"
				variant="danger"
				confirmLabel="Make private"
				pendingLabel="Revoking…"
				isPending={updateAccess.isPending}
				description="Active public visitors will be disconnected immediately and public app sandboxes will be stopped. Signed-in members are unaffected."
				onConfirm={() => {
					if (!pendingToggle || pendingToggle.kind !== 'disable') return;
					updateAccess.mutate(
						{
							slug: pendingToggle.slug,
							registration_id: pendingToggle.registration_id,
							access: { mode: 'inherit' },
						},
						{
							onSuccess: () => {
								setPendingToggle(null);
								toast.success('Public access disabled');
							},
							onError: () => {
								setPendingToggle(null);
							},
						},
					);
				}}
			/>
		</>
	);
}
