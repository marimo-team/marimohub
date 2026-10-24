import { MAX_UPLOAD_BYTES } from '@marimo-hub/core/uploads';
import { withBasePath } from '@/lib/basePath';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui';
import { ApiRequestError } from '@/api/client';
import { formatBytes } from '@/lib/formatBytes';
import { resumableUpload } from '@/lib/resumableUpload';
import type { UploadProgress } from '@/lib/resumableUpload';
import { UploadProgressList } from '../WorkspaceBrowser/UploadProgressList';

interface ObjectUploadButtonProps {
	projectId: string;
	integrationId: string;
	bucket: string;
	prefix: string;
	onComplete: () => void;
}

export function ObjectUploadButton(props: ObjectUploadButtonProps) {
	return (
		<ObjectUploadForm
			key={JSON.stringify([props.projectId, props.integrationId, props.bucket, props.prefix])}
			{...props}
		/>
	);
}

function ObjectUploadForm({
	projectId,
	integrationId,
	bucket,
	prefix,
	onComplete,
}: ObjectUploadButtonProps) {
	const input = useRef<HTMLInputElement>(null);
	const active = useRef<AbortController | null>(null);
	const [busy, setBusy] = useState(false);
	const [progress, setProgress] = useState<UploadProgress | null>(null);
	const [errors, setErrors] = useState<string[]>([]);
	const [restartFiles, setRestartFiles] = useState<File[]>([]);
	useEffect(
		() => () => {
			active.current?.abort();
			active.current = null;
		},
		[],
	);

	async function upload(files: File[], restart = false) {
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
		setRestartFiles([]);
		const failures: string[] = [];
		const conflicts: File[] = [];
		let needsRefresh = false;
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
						restart,
						signal: controller.signal,
						onProgress: (value) => {
							if (value?.phase === 'publishing') needsRefresh = true;
							if (active.current === controller) setProgress(value);
						},
					},
				);
				needsRefresh = true;
			} catch (error) {
				if (controller.signal.aborted) break;
				if (error instanceof ApiRequestError && error.status === 409) conflicts.push(file);
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
			setRestartFiles(conflicts);
			setProgress(null);
			setBusy(false);
		}
		if (needsRefresh) onComplete();
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
			{restartFiles.map((file) => (
				<Button
					key={file.name}
					onPress={() => {
						if (
							window.confirm(
								`Restart ${file.name}? Check the destination first: the previous upload may have succeeded. Restarting discards saved progress and can replace the object.`,
							)
						)
							void upload([file], true);
					}}
				>
					Restart {file.name}
				</Button>
			))}
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
