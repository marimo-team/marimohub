import { Toaster as Sonner } from 'sonner';
import type { ToasterProps } from 'sonner';
import { useTheme } from '@/context/ThemeContext';

export function Toaster(props: ToasterProps) {
	const { theme } = useTheme();

	return (
		<Sonner
			theme={theme}
			className="toaster group"
			position="bottom-right"
			richColors
			style={
				{
					'--normal-bg': 'var(--popover)',
					'--normal-text': 'var(--popover-foreground)',
					'--normal-border': 'var(--border)',
					fontFamily: 'var(--font-sans)',
				} as React.CSSProperties
			}
			{...props}
		/>
	);
}
