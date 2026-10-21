import { MAX_UPLOAD_BYTES } from '@marimo-hub/core/uploads';
import { withBasePath } from '@/lib/basePath';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui';
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
	const [busy, setBusy] = useState(false);
	const [progress, setProgress] = useState<UploadProgress | null>(null);
	const [error, setError] = useState<string | null>(null);
	async function upload(files: File[]) {
		setBusy(true);
		setError(null);
		try {
			for (const file of files) {
				if (file.size > MAX_UPLOAD_BYTES) throw new Error('Object uploads must be at most 5 GiB');
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
					{ onProgress: setProgress },
				);
				onComplete();
			}
		} catch (error) {
			setError(error instanceof Error ? error.message : 'Upload failed');
		}
		setBusy(false);
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
			<p className="text-xs text-muted-foreground">Files with the same name are replaced.</p>
			{progress && <UploadProgressList uploads={{ active: progress }} />}
			{error && (
				<p role="alert" className="text-xs text-destructive">
					{error} Select the same file to resume an interrupted upload.
				</p>
			)}
		</div>
	);
}
