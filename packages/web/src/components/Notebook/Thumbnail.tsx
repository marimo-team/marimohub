import { useState } from 'react';
import { FileText } from 'lucide-react';
import type { useThumbnail } from '@/api/thumbnails';
import { thumbnailUrl } from '@/api/thumbnails';

export function Thumbnail({
	projectId,
	notebookId,
	title,
	metadata,
	refreshedAt,
}: {
	projectId: string;
	notebookId: string;
	title: string;
	metadata: ReturnType<typeof useThumbnail>['data'];
	refreshedAt: number;
}) {
	const src = metadata?.source
		? `${thumbnailUrl(projectId, notebookId)}/image?r=${encodeURIComponent(metadata.revision ?? '')}`
		: null;
	const attempt = `${src}:${refreshedAt}`;
	const [failed, setFailed] = useState<string | null>(null);
	return (
		<div className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-t-lg bg-gradient-to-br from-primary/10 via-muted to-primary/5">
			{src && failed !== attempt ? (
				<img
					src={src}
					alt=""
					width={960}
					height={540}
					loading="lazy"
					className="size-full object-cover"
					onError={() => setFailed(attempt)}
				/>
			) : (
				<div className="flex min-w-0 flex-col items-center gap-3 px-6 text-muted-foreground">
					<FileText className="size-9 opacity-60" />
					<span className="line-clamp-2 text-center text-sm font-medium">{title}</span>
				</div>
			)}
		</div>
	);
}
