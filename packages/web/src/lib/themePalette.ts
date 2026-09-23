import { ColorSpace, OKLCH, sRGB, to, toGamut, serialize, contrastWCAG21 } from 'colorjs.io/fn';
import type { ThemeConfig } from '@marimo-hub/api/theme';

ColorSpace.register(sRGB);
ColorSpace.register(OKLCH);

type Seed = { chroma: number; hue: number };
export type ThemeTokens = Record<string, string>;
export interface ThemePalette {
	light: ThemeTokens;
	dark: ThemeTokens;
}

function seed(color: string): Seed {
	const [, chroma, hue] = to(color, OKLCH).coords;
	return { chroma: chroma ?? 0, hue: hue !== null && Number.isFinite(hue) ? hue : 0 };
}

function tone(lightness: number, { chroma, hue }: Seed): string {
	const mapped = toGamut(
		{ space: OKLCH, coords: [lightness, chroma, hue], alpha: 1 },
		{ space: 'srgb', method: 'oklch.c' },
	);
	return serialize(to(mapped, sRGB), { format: 'hex' });
}

function readableTone(
	lightness: number,
	color: Seed,
	backgrounds: string[],
	dark: boolean,
	minimum = 4.5,
): string {
	// Check quantized sRGB output, including the least favorable surface.
	for (let step = 0; step <= 100; step++) {
		const l = Math.max(0, Math.min(1, lightness + (dark ? step : -step) / 100));
		const candidate = tone(l, color);
		if (backgrounds.every((background) => contrastWCAG21(candidate, background) >= minimum)) {
			return candidate;
		}
	}
	return dark ? '#ffffff' : '#000000';
}

function onColor(background: string): string {
	return contrastWCAG21(background, '#ffffff') >= contrastWCAG21(background, '#000000')
		? '#ffffff'
		: '#000000';
}

function modePalette(primarySeed: Seed, secondarySeed: Seed, dark: boolean): ThemeTokens {
	const neutral = {
		...secondarySeed,
		chroma: Math.min(secondarySeed.chroma, dark ? 0.015 : 0.008),
	};
	const primary = { ...primarySeed, chroma: Math.min(primarySeed.chroma, 0.18) };
	const secondary = { ...secondarySeed, chroma: Math.min(secondarySeed.chroma, 0.035) };
	const surfaceTokens = {
		background: tone(dark ? 0.155 : 0.982, neutral),
		card: tone(dark ? 0.205 : 1, neutral),
		popover: tone(dark ? 0.215 : 1, neutral),
		secondary: tone(dark ? 0.27 : 0.97, secondary),
		muted: tone(dark ? 0.27 : 0.968, neutral),
		accent: tone(dark ? 0.28 : 0.968, secondary),
		sidebar: tone(dark ? 0.215 : 0.985, neutral),
	};
	const surfaces = Object.values(surfaceTokens);
	const tokens: ThemeTokens = {
		...surfaceTokens,
		border: tone(dark ? 0.35 : 0.9, neutral),
		input: tone(dark ? 0.4 : 0.87, neutral),
	};
	const foreground = readableTone(dark ? 0.97 : 0.23, neutral, surfaces, dark);
	const brand = readableTone(dark ? 0.72 : 0.55, primary, surfaces, dark);
	const brandForeground = onColor(brand);
	const brandHover = readableTone(dark ? 0.78 : 0.49, primary, surfaces, dark);
	Object.assign(tokens, {
		foreground,
		'card-foreground': foreground,
		'popover-foreground': foreground,
		'secondary-foreground': foreground,
		'muted-foreground': readableTone(dark ? 0.72 : 0.5, neutral, surfaces, dark),
		'accent-foreground': foreground,
		primary: brand,
		'primary-foreground': brandForeground,
		'primary-hover': brandHover,
		'primary-hover-foreground': onColor(brandHover),
		ring: brand,
		'sidebar-foreground': foreground,
		'sidebar-primary': brand,
		'sidebar-primary-foreground': brandForeground,
		'sidebar-accent': tokens.accent,
		'sidebar-accent-foreground': foreground,
		'sidebar-border': tokens.border,
		'sidebar-ring': brand,
	});
	const hueDelta = ((secondarySeed.hue - primarySeed.hue + 540) % 360) - 180;
	for (let index = 0; index < 5; index++) {
		tokens[`chart-${index + 1}`] = tone((dark ? 0.8 : 0.7) - index * 0.07, {
			hue: primarySeed.hue + hueDelta * (index / 4),
			chroma: Math.min(0.16, Math.max(primarySeed.chroma, secondarySeed.chroma)),
		});
	}
	return tokens;
}

export function generateThemePalette(
	config: Pick<ThemeConfig, 'primary_color' | 'secondary_color'>,
): ThemePalette | null {
	if (!config.primary_color && !config.secondary_color) return null;
	const primary = seed(config.primary_color ?? 'oklch(0.511 0.096 186.391)');
	const secondary = config.secondary_color ? seed(config.secondary_color) : primary;
	return {
		light: modePalette(primary, secondary, false),
		dark: modePalette(primary, secondary, true),
	};
}
