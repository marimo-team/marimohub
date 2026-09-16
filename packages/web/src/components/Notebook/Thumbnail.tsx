import { useState } from 'react';
import { FileText } from 'lucide-react';
import { useThumbnail, thumbnailUrl } from '@/api/thumbnails';

export function Thumbnail({
	projectId,
	notebookId,
	title,
}: {
	projectId: string;
	notebookId: string;
	title: string;
}) {
	const { data } = useThumbnail(projectId, notebookId);
	const src = data?.source
		? `${thumbnailUrl(projectId, notebookId)}/image?r=${encodeURIComponent(data.revision ?? '')}`
		: null;
	const [failed, setFailed] = useState<string | null>(null);
	return (
		<div className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-t-lg bg-gradient-to-br from-primary/10 via-muted to-primary/5">
			{src && failed !== src ? (
				<img
					src={src}
					alt=""
					width={960}
					height={540}
					loading="lazy"
					className="size-full object-cover"
					onError={() => setFailed(src)}
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
