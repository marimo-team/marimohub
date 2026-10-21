import { MAX_UPLOAD_BYTES } from '@marimo-hub/core/uploads';
import { withBasePath } from '@/lib/basePath';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui';
import { formatBytes } from '@/lib/formatBytes';
import { resumableUpload } from '@/lib/resumableUpload';
import type { UploadProgress } from '@/lib/resumableUpload';
import { UploadProgressList } from '../WorkspaceBrowser/UploadProgressList';

export function ObjectUploadButton({
	projectId,
	integrationId,
	bucket,
	prefix,
	onComplete,
}: {
	projectId: string;
	integrationId: string;
	bucket: string;
	prefix: string;
	onComplete: () => void;
}) {
	const input = useRef<HTMLInputElement>(null);
	const active = useRef<AbortController | null>(null);
	const [busy, setBusy] = useState(false);
	const [progress, setProgress] = useState<UploadProgress | null>(null);
	const [errors, setErrors] = useState<string[]>([]);
	useEffect(
		() => () => {
			active.current?.abort();
			active.current = null;
		},
		[],
	);

	async function upload(files: File[]) {
		if (active.current || files.length === 0) return;
		const oversized = files.filter((file) => file.size > MAX_UPLOAD_BYTES);
		if (oversized.length > 0) {
			setErrors(
				oversized.map(
					(file) => `${file.name} exceeds the ${formatBytes(MAX_UPLOAD_BYTES)} upload limit.`,
				),
			);
			return;
		}
		const controller = new AbortController();
		active.current = controller;
		setBusy(true);
		setErrors([]);
		const failures: string[] = [];
		let completed = 0;
		for (const file of files) {
			if (controller.signal.aborted) break;
			try {
				await resumableUpload(
					withBasePath(
						`/api/v1/projects/${encodeURIComponent(projectId)}/integrations/${encodeURIComponent(integrationId)}/browse/objects/uploads`,
					),
					file,
					{
						bucket,
						path: `${prefix}${file.name}`,
						content_type: file.type || 'application/octet-stream',
					},
					{
						signal: controller.signal,
						onProgress: (value) => {
							if (active.current === controller) setProgress(value);
						},
					},
				);
				completed++;
			} catch (error) {
				if (controller.signal.aborted) break;
				const message = error instanceof Error ? error.message : 'Upload failed';
				const hint =
					error instanceof TypeError
						? ' Select the same file to resume an interrupted upload.'
						: '';
				failures.push(`${file.name}: ${message.replace(/[.!?]$/, '')}.${hint}`);
			}
		}
		if (active.current === controller) {
			active.current = null;
			if (controller.signal.aborted) {
				failures.push('Upload cancelled. Select the same files to resume unfinished uploads.');
			}
			setErrors(failures);
			setProgress(null);
			setBusy(false);
			if (completed > 0) onComplete();
		}
	}
	return (
		<div className="space-y-2">
			<input
				ref={input}
				type="file"
				multiple
				className="hidden"
				aria-label="Upload objects"
				onChange={(event) => {
					const files = [...(event.target.files ?? [])];
					event.target.value = '';
					void upload(files);
				}}
			/>
			<Button isDisabled={busy} onPress={() => input.current?.click()}>
				{busy ? 'Uploading…' : 'Upload'}
			</Button>
			{busy && <Button onPress={() => active.current?.abort()}>Cancel upload</Button>}
			<p className="text-xs text-muted-foreground">Files with the same name are replaced.</p>
			{progress && <UploadProgressList uploads={{ active: progress }} />}
			{errors.length > 0 && (
				<div role="alert" className="text-xs text-destructive">
					{[...new Set(errors)].map((error) => (
						<p key={error}>{error}</p>
					))}
				</div>
			)}
		</div>
	);
}
