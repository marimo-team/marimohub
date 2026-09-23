import { useBranding } from '@/context/BrandingContext';

export function PageTitle({ children }: { children: string }) {
	const { name } = useBranding();
	return <title>{`${children} · ${name}`}</title>;
}
