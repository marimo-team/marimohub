import { useState } from 'react';
import { useBranding } from '@/context/BrandingContext';
import { useTheme } from '@/context/ThemeContext';
import { Circle } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface BrandProps {
	/** Larger mark + wordmark, for standalone screens like sign-in. */
	size?: 'sm' | 'lg';
	/** Applies to the built-in wordmark and image-failure fallback, not custom logos. */
	builtInWordmarkClassName?: string;
	className?: string;
}

function BuiltInBrand({ size = 'sm', builtInWordmarkClassName, className }: BrandProps) {
	const { wordmark, hasCustomColors } = useBranding();
	return (
		<span className={cn('flex items-center', size === 'sm' ? 'gap-2.5' : 'gap-3', className)}>
			<span
				className={cn(
					'flex items-center justify-center rounded-lg shadow-sm ring-1 ring-black/5 dark:ring-white/10',
					hasCustomColors
						? 'bg-primary text-primary-foreground'
						: 'bg-gradient-to-br from-teal-500 to-teal-700 text-white dark:from-teal-400 dark:to-teal-600',
					size === 'sm' ? 'size-7' : 'size-10 rounded-xl',
				)}
			>
				<Circle className={size === 'sm' ? 'size-4' : 'size-5'} strokeWidth={2.5} />
			</span>
			<span
				className={cn(
					'font-mono font-semibold tracking-[0.16em] text-foreground',
					size === 'sm' ? 'text-[13px]' : 'text-base',
					builtInWordmarkClassName,
				)}
			>
				{wordmark}
			</span>
		</span>
	);
}

function CustomBrand(props: BrandProps) {
	const { name, logo, logo_dark } = useBranding();
	const { theme } = useTheme();
	const [failedUrls, setFailedUrls] = useState<string[]>([]);
	const candidates = theme === 'dark' ? [logo_dark, logo] : [logo];
	const src = candidates.find((url) => url && !failedUrls.includes(url));
	if (!src) return <BuiltInBrand {...props} />;
	return (
		<img
			src={src}
			alt={name}
			referrerPolicy="no-referrer"
			className={cn(
				'shrink-0 object-contain object-left',
				props.size === 'lg' ? 'h-10 max-w-56' : 'h-7 max-w-36 max-md:max-w-28',
				props.className,
			)}
			onError={() => setFailedUrls((urls) => [...urls, src])}
		/>
	);
}

export function Brand(props: BrandProps) {
	const { logo, logo_dark } = useBranding();
	return logo || logo_dark ? (
		<CustomBrand key={`${logo}:${logo_dark}`} {...props} />
	) : (
		<BuiltInBrand {...props} />
	);
}
