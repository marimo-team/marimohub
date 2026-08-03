import type { SVGProps } from 'react';
import { siApachehive, siApachespark, siGooglebigquery, siPostgresql, siTrino } from 'simple-icons';

// Explicit named imports so the bundler tree-shakes the ~3k other icons away.
const ICONS = {
	postgresql: siPostgresql,
	trino: siTrino,
	apachehive: siApachehive,
	googlebigquery: siGooglebigquery,
	apachespark: siApachespark,
};

export type BrandIconComponent = (props: SVGProps<SVGSVGElement>) => React.JSX.Element;

/** Vendor logos keyed by the kind's `brand.icon` slug. */
export const BRAND_ICONS: Record<string, BrandIconComponent> = Object.fromEntries(
	Object.entries(ICONS).map(([slug, icon]) => [
		slug,
		(props: SVGProps<SVGSVGElement>) => (
			<svg viewBox="0 0 24 24" fill="currentColor" {...props}>
				<path d={icon.path} />
			</svg>
		),
	]),
);
