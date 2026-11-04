import { Moon, Sun } from 'lucide-react';
import type { ThemeConfig } from '@marimo-hub/core/theme';
import {
	DEFAULT_PALETTE_PRIMARY,
	generateThemePalette,
	getNotebookPaletteTokens,
	NOTEBOOK_TOKEN_ALIASES,
} from '@marimo-hub/core/theme-palette';
import { PageContainer, PageHeader } from '@/components/ui';
import { PageTitle } from '@/components/ui/PageTitle';
import { useBranding } from '@/context/BrandingContext';

const PALETTE_DESCRIPTIONS: Record<ThemeConfig['notebook_palette'], string> = {
	off: 'Native marimo colors. No generated tokens are applied.',
	accents: 'Brand colors for actions, links, and focus rings.',
	full: 'The full brand palette, including surfaces, text, and charts.',
};

function Swatch({ color }: { color: string }) {
	return (
		<span
			aria-hidden="true"
			className="size-6 shrink-0 rounded-md border border-current/20"
			style={{ backgroundColor: color }}
		/>
	);
}

function ConfiguredColor({
	label,
	variable,
	color,
	fallback,
}: {
	label: string;
	variable: string;
	color: string | null;
	fallback: string;
}) {
	return (
		<section className="min-w-0 rounded-xl border bg-card p-5">
			<h2 className="text-sm font-medium text-muted-foreground">{label}</h2>
			<div className="mt-3 flex items-center gap-3">
				{color ? <Swatch color={color} /> : null}
				<span className="font-mono text-lg font-medium">{color ?? 'Not set'}</span>
			</div>
			<p className="mt-2 text-xs text-muted-foreground">{fallback}</p>
			<code className="mt-3 block break-all text-[11px] text-muted-foreground">{variable}</code>
		</section>
	);
}

export default function AdminColorsPage() {
	const theme = useBranding();
	const configuredPalette = generateThemePalette(theme);
	const palette =
		configuredPalette ??
		generateThemePalette({
			primary_color: DEFAULT_PALETTE_PRIMARY,
			secondary_color: null,
		})!;
	const mode = theme.notebook_palette;
	const tokens = getNotebookPaletteTokens(palette, 'full');
	const appliedTokens = new Set(getNotebookPaletteTokens(configuredPalette, mode));
	const columns = (['light', 'dark'] as const).map((appearance) => ({
		appearance,
		label: appearance === 'light' ? 'Light' : 'Dark',
		Icon: appearance === 'light' ? Sun : Moon,
		colors: palette[appearance],
		style: {
			backgroundColor: palette[appearance].background,
			color: palette[appearance].foreground,
		},
	}));

	return (
		<PageContainer width="wide">
			<PageTitle>Colors</PageTitle>
			<PageHeader>
				<div className="flex flex-col gap-1">
					<h1 className="text-xl font-semibold tracking-tight">Colors</h1>
					<p className="text-sm text-muted-foreground">
						Deployment branding and the generated notebook palette. Read-only configuration from
						server startup.
					</p>
				</div>
			</PageHeader>

			<div className="mb-8 grid gap-4 md:grid-cols-3">
				<ConfiguredColor
					label="Primary color"
					variable="MARIMOHUB_THEME_PRIMARY_COLOR"
					color={theme.primary_color}
					fallback={
						theme.primary_color
							? 'Seed for actions, links, and focus.'
							: 'Uses the default teal when a palette is generated.'
					}
				/>
				<ConfiguredColor
					label="Secondary color"
					variable="MARIMOHUB_THEME_SECONDARY_COLOR"
					color={theme.secondary_color}
					fallback={
						theme.secondary_color
							? 'Seed for surfaces and supporting colors.'
							: 'Follows the primary color when a palette is generated.'
					}
				/>
				<section className="min-w-0 rounded-xl border bg-card p-5">
					<h2 className="text-sm font-medium text-muted-foreground">Notebook palette</h2>
					<div className="mt-3 font-mono text-lg font-medium">{mode}</div>
					<p className="mt-2 text-xs text-muted-foreground">{PALETTE_DESCRIPTIONS[mode]}</p>
					<code className="mt-3 block break-all text-[11px] text-muted-foreground">
						MARIMOHUB_THEME_NOTEBOOK_PALETTE
					</code>
				</section>
			</div>

			<section aria-labelledby="notebook-tokens-heading">
				<h2 id="notebook-tokens-heading" className="text-lg font-semibold">
					Notebook tokens
				</h2>
				<p className="mt-1 text-sm text-muted-foreground">
					{configuredPalette
						? 'All generated tokens are shown, including those not applied in the current mode.'
						: 'No brand colors are configured. This reference uses the default teal; no generated tokens are applied.'}{' '}
					These are generated values, not native marimo defaults. Custom CSS can override them.
				</p>
				<div className="mt-4 overflow-x-auto rounded-xl border">
					<table className="w-full min-w-[640px] text-left text-xs">
						<caption className="sr-only">
							Generated notebook color tokens in light and dark mode
						</caption>
						<thead>
							<tr className="border-b">
								<th scope="col" className="px-4 py-4 font-medium">
									CSS token
								</th>
								<th scope="col" className="px-4 py-4 font-medium">
									Notebook
								</th>
								{columns.map(({ appearance, label, Icon, style }) => (
									<th key={appearance} scope="col" className="px-5 py-4 font-medium" style={style}>
										<span className="flex items-center gap-2">
											<Icon className="size-4" />
											{label}
										</span>
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{tokens.map((token) => (
								<tr key={token} className="border-b last:border-b-0">
									<th scope="row" className="px-4 py-2 font-mono font-normal">
										--{token}
									</th>
									<td className="px-4 py-2 text-muted-foreground">
										{appliedTokens.has(token) ? 'Applied' : 'Preview only'}
									</td>
									{columns.map(({ appearance, colors, style }) => (
										<td key={appearance} className="px-5 py-2" style={style}>
											<div className="flex items-center gap-3">
												<Swatch color={colors[NOTEBOOK_TOKEN_ALIASES[token] ?? token]} />
												<code>{colors[NOTEBOOK_TOKEN_ALIASES[token] ?? token]}</code>
											</div>
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</section>
		</PageContainer>
	);
}
