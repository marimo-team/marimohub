import type { UploadProgress } from '@/lib/resumableUpload';

export function UploadProgressList({ uploads }: { uploads: Record<string, UploadProgress> }) {
	return (
		<div>
			<output className="sr-only">
				{Object.values(uploads)
					.map(
						(upload) =>
							`${upload.path}: ${upload.phase === 'preparing' ? 'Preparing' : upload.phase === 'publishing' ? 'Saving' : 'Uploading'}`,
					)
					.join('; ')}
			</output>
			{Object.entries(uploads).map(([key, upload]) => (
				<div key={key} className="border-b px-3 py-2 text-xs">
					<div className="mb-1 flex justify-between gap-3">
						<span className="truncate">{upload.path}</span>
						<span>
							{upload.phase === 'preparing'
								? 'Preparing'
								: upload.phase === 'publishing'
									? 'Saving'
									: `${Math.round((upload.loaded / Math.max(1, upload.total)) * 100)}%`}
						</span>
					</div>
					<progress
						aria-label={`Upload ${upload.path}`}
						className="h-1 w-full"
						max={Math.max(1, upload.total)}
						value={upload.loaded}
					/>
				</div>
			))}
		</div>
	);
}
