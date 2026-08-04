import { useState } from 'react';
import { cn } from '@/lib/utils';

export interface UserAvatarProps {
	pictureUrl?: string | null;
	label: string;
	className?: string;
}

function AvatarContent({ pictureUrl, label }: Pick<UserAvatarProps, 'pictureUrl' | 'label'>) {
	const [pictureFailed, setPictureFailed] = useState(false);
	const initialCodePoint = label.trim().codePointAt(0);
	const initial =
		initialCodePoint === undefined ? '' : String.fromCodePoint(initialCodePoint).toUpperCase();

	if (!pictureUrl || pictureFailed) {
		return initial;
	}

	return (
		<img
			src={pictureUrl}
			alt=""
			referrerPolicy="no-referrer"
			className="size-full object-cover"
			onError={() => setPictureFailed(true)}
		/>
	);
}

export function UserAvatar({ pictureUrl, label, className }: UserAvatarProps) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				'relative flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-gradient-to-br from-teal-500/15 to-teal-600/25 font-semibold text-primary ring-1 ring-primary/20',
				className,
			)}
		>
			<AvatarContent key={pictureUrl ?? ''} pictureUrl={pictureUrl} label={label} />
		</span>
	);
}
