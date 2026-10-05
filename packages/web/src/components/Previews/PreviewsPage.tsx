import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { RadioButton, RadioField, RadioGroup, Label } from 'react-aria-components';
import { useAppQuery } from '@/api/apps';
import { useCapabilitiesQuery, useNotebookQuery } from '@/api/hooks';
import {
	hasNotebookPreviews,
	useCreatePreview,
	useDeletePreview,
	usePreviewsQuery,
} from '@/api/previews';
import type { NotebookPreview } from '@/api/previews';
import { Button, DialogModal } from '@/components/ui';
import { copyPreviewLink } from './copyPreviewLink';
import { SourceRefInput } from './SourceRefInput';

export function PreviewBadge({ preview }: { preview: NotebookPreview }) {
	return (
		<span className="rounded border px-2 py-0.5 text-xs">
			{preview.source_type === 'branch' ? 'Following branch' : 'Pinned commit'}
		</span>
	);
}
export function PreviewsPage() {
	const { pid = '', nid = '' } = useParams();
	const capabilities = useCapabilitiesQuery();
	const previewsAvailable = hasNotebookPreviews(capabilities.data);
	const query = usePreviewsQuery(pid, nid);
	const parent = useAppQuery(pid, nid);
	const canManage = parent.data?.your_role === 'manager' || parent.data?.your_role === 'admin';
	const [creating, setCreating] = useState(false);
	const [deleting, setDeleting] = useState<NotebookPreview | null>(null);
	const remove = useDeletePreview(pid, nid);
	return (
		<main className="mx-auto max-w-4xl space-y-6 p-6">
			<Link to={`/projects/${pid}/notebooks/${nid}/app`} className="text-sm text-muted-foreground">
				Back to notebook
			</Link>
			<div className="flex items-center justify-between">
				<h1 className="text-xl font-semibold">Previews</h1>
				{canManage && previewsAvailable && (
					<PreviewCreation pid={pid} nid={nid} onCreate={() => setCreating(true)} />
				)}
			</div>
			<p className="text-sm text-muted-foreground">
				Share published previews with this notebook’s audience. Temporary editor changes are
				discarded.
			</p>
			{capabilities.isSuccess && !previewsAvailable && (
				<p>Preview creation requires a GitHub App connection.</p>
			)}
			{query.isError && <p role="alert">{query.error.message}</p>}
			{query.isPending && <output>Loading previews…</output>}
			{query.data?.length === 0 && <p>No previews yet.</p>}
			{query.data?.map((preview) => (
				<article key={preview.id} className="space-y-3 rounded-lg border p-4">
					<div className="flex flex-wrap items-center gap-3">
						<h2 className="font-medium">{preview.name}</h2>
						<PreviewBadge preview={preview} />
						<span className="text-xs">{preview.preparation}</span>
					</div>
					<p className="text-sm text-muted-foreground">
						{preview.source?.type === 'branch' ? `${preview.source.branch} · ` : ''}
						{preview.commit?.slice(0, 12) ?? 'Awaiting first revision'} · Expires{' '}
						{new Date(preview.expires_at).toLocaleString()}
					</p>
					{preview.error && (
						<p role="alert" className="text-sm">
							{preview.error} {preview.commit && 'The last prepared revision remains available.'}
						</p>
					)}
					<div className="flex flex-wrap gap-2">
						<Link
							className="rounded border px-3 py-2 text-sm"
							to={`/projects/${pid}/notebooks/${nid}/previews/${preview.id}`}
						>
							Open preview
						</Link>
						<Button variant="default" onPress={() => void copyPreviewLink(preview.url)}>
							Copy link
						</Button>
						{preview.can.manage && (
							<Button
								variant="default"
								isDisabled={remove.isPending}
								onPress={() => {
									remove.reset();
									setDeleting(preview);
								}}
							>
								Delete
							</Button>
						)}
					</div>
				</article>
			))}
			{deleting && (
				<DialogModal
					isOpen
					onClose={() => {
						if (!remove.isPending) setDeleting(null);
					}}
					title="Delete preview"
				>
					<p className="text-sm">
						Delete “{deleting.name}”? Reviewers will lose access immediately, and running sessions
						will be stopped.
					</p>
					{remove.isError && (
						<p role="alert" className="mt-3 text-sm">
							{remove.error.message}
						</p>
					)}
					<div className="mt-4 flex justify-end gap-2">
						<Button
							variant="default"
							isDisabled={remove.isPending}
							onPress={() => setDeleting(null)}
						>
							Cancel
						</Button>
						<Button
							variant="danger"
							isDisabled={remove.isPending}
							onPress={() => remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}
						>
							{remove.isPending ? 'Deleting…' : 'Delete preview'}
						</Button>
					</div>
				</DialogModal>
			)}
			{creating && previewsAvailable && (
				<DialogModal isOpen onClose={() => setCreating(false)} title="Create preview">
					<CreatePreviewForm pid={pid} nid={nid} onCreated={() => setCreating(false)} />
				</DialogModal>
			)}
		</main>
	);
}

function PreviewCreation({
	pid,
	nid,
	onCreate,
}: {
	pid: string;
	nid: string;
	onCreate: () => void;
}) {
	const notebook = useNotebookQuery(pid, nid);
	return notebook.data?.source.type === 'git' ? (
		<Button onPress={onCreate}>Create preview</Button>
	) : notebook.data ? (
		<p className="text-sm text-muted-foreground">Preview creation requires a Git notebook.</p>
	) : null;
}

export function CreatePreviewForm({
	pid,
	nid,
	onCreated,
}: {
	pid: string;
	nid: string;
	onCreated: () => void;
}) {
	const [type, setType] = useState<'branch' | 'commit'>('branch');
	const [value, setValue] = useState('');
	const [name, setName] = useState('');
	const [profile, setProfile] = useState('');
	const requestKey = useRef<string | null>(null);
	const capabilities = useCapabilitiesQuery();
	const notebook = useNotebookQuery(pid, nid);
	const create = useCreatePreview(pid, nid);
	const valid =
		hasNotebookPreviews(capabilities.data) &&
		name.trim() &&
		value.trim() &&
		(type === 'branch' || /^[a-f0-9]{40}$/i.test(value.trim()));
	const change = (next: string) => {
		setValue(next);
		requestKey.current = null;
	};
	return (
		<form
			className="space-y-4"
			onSubmit={(event) => {
				event.preventDefault();
				if (!valid) return;
				if (requestKey.current === null) requestKey.current = crypto.randomUUID();
				create.mutate(
					{
						name: name.trim(),
						source:
							type === 'branch' ? { type, branch: value.trim() } : { type, commit: value.trim() },
						...(profile ? { compute_profile: profile } : {}),
						requestKey: requestKey.current,
					},
					{ onSuccess: onCreated },
				);
			}}
		>
			<label className="block space-y-1 text-sm">
				Name
				<input
					aria-label="Name"
					required
					className="block w-full rounded border bg-background p-2"
					value={name}
					onChange={(event) => {
						setName(event.target.value);
						requestKey.current = null;
					}}
					maxLength={100}
				/>
			</label>
			{notebook.data?.source.type === 'git' && (
				<p className="text-sm text-muted-foreground">Repository: {notebook.data.source.repo}</p>
			)}
			<RadioGroup
				value={type}
				onChange={(next) => {
					setType(next as 'branch' | 'commit');
					change('');
				}}
				className="space-y-2"
			>
				<Label className="text-sm font-medium">Source</Label>
				<RadioField value="branch">
					<RadioButton className="block cursor-pointer rounded border p-2 text-sm data-[selected]:border-primary data-[focus-visible]:outline-2 data-[focus-visible]:outline-ring">
						Follow a branch
					</RadioButton>
				</RadioField>
				<RadioField value="commit">
					<RadioButton className="block cursor-pointer rounded border p-2 text-sm data-[selected]:border-primary data-[focus-visible]:outline-2 data-[focus-visible]:outline-ring">
						Pin to a commit
					</RadioButton>
				</RadioField>
			</RadioGroup>
			<SourceRefInput key={type} pid={pid} nid={nid} type={type} value={value} onChange={change} />
			<p className="text-sm text-muted-foreground">
				{type === 'branch'
					? 'Automatically updates when new commits are pushed to this branch.'
					: 'Always runs this commit. New pushes will not update this preview. Enter the full 40-character SHA.'}
			</p>
			{capabilities.data?.compute_profile_override === 'editors' && (
				<label className="block space-y-1 text-sm">
					Compute profile
					<select
						className="block w-full rounded border bg-background p-2"
						value={profile}
						onChange={(event) => {
							setProfile(event.target.value);
							requestKey.current = null;
						}}
					>
						<option value="">Preview default</option>
						{capabilities.data.compute_profiles.map((item) => (
							<option key={item.name} value={item.name}>
								{item.name}
							</option>
						))}
					</select>
				</label>
			)}
			<p className="text-sm">Uses this notebook’s integrations and secrets.</p>
			<p className="text-sm text-muted-foreground">
				Inherits notebook access. Expires after 7 days.
			</p>
			{value && (
				<p className="text-sm font-medium">
					{type === 'branch' ? `Follows ${value} automatically` : `Pinned to ${value.slice(0, 12)}`}
				</p>
			)}
			{create.isError && (
				<p role="alert" className="text-sm">
					{create.error.message}
				</p>
			)}
			<Button type="submit" isDisabled={!valid || create.isPending}>
				{create.isPending ? 'Creating preview…' : 'Create preview'}
			</Button>
		</form>
	);
}
