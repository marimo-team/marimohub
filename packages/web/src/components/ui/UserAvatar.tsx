import { useState } from 'react';
import { cn } from '@/lib/utils';

export interface UserAvatarProps {
	pictureUrl?: string | null;
	label: string;
	className?: string;
}

export function UserAvatar({ pictureUrl, label, className }: UserAvatarProps) {
	const [failedUrl, setFailedUrl] = useState<string | null>(null);
	const showPicture = Boolean(pictureUrl && pictureUrl !== failedUrl);

	return (
		<span
			aria-hidden="true"
			className={cn(
				'relative flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-gradient-to-br from-teal-500/15 to-teal-600/25 font-semibold text-primary ring-1 ring-primary/20',
				className,
			)}
		>
			{showPicture ? (
				<img
					src={pictureUrl ?? undefined}
					alt=""
					referrerPolicy="no-referrer"
					className="size-full object-cover"
					onError={() => setFailedUrl(pictureUrl ?? null)}
				/>
			) : (
				label.charAt(0).toUpperCase()
			)}
		</span>
	);
}
