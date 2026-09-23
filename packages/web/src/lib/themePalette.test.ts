import { describe, expect, it } from 'vitest';
import { contrastWCAG21, inGamut, to, sRGB } from 'colorjs.io/fn';
import { generateThemePalette } from './themePalette';

const seeds = [
	'#2563eb',
	'#7c3aed',
	'#ff0000',
	'#00ff00',
	'#0000ff',
	'#ffff00',
	'#000000',
	'#ffffff',
	'#888888',
];

describe('generated theme palettes', () => {
	it('leaves stock tokens alone without custom colors', () => {
		expect(generateThemePalette({ primary_color: null, secondary_color: null })).toBeNull();
	});

	it.each(
		[null, ...seeds].flatMap((primary) =>
			[null, ...seeds]
				.filter((secondary) => primary !== null || secondary !== null)
				.map((secondary) => ({ primary, secondary })),
		),
	)(
		'keeps primary=$primary and secondary=$secondary readable in both modes',
		({ primary, secondary }) => {
			const palette = generateThemePalette({ primary_color: primary, secondary_color: secondary })!;
			for (const tokens of [palette.light, palette.dark]) {
				for (const value of Object.values(tokens)) {
					expect(
						to(value, sRGB).coords.every(
							(coord) => typeof coord === 'number' && Number.isFinite(coord),
						),
					).toBe(true);
					expect(inGamut(value, sRGB)).toBe(true);
				}
				for (const surface of [
					'background',
					'card',
					'popover',
					'secondary',
					'muted',
					'accent',
					'sidebar',
				]) {
					for (const text of ['foreground', 'muted-foreground', 'primary']) {
						expect(
							contrastWCAG21(tokens[text], tokens[surface]),
							`${text} on ${surface}`,
						).toBeGreaterThanOrEqual(4.5);
					}
					expect(contrastWCAG21(tokens.ring, tokens[surface])).toBeGreaterThanOrEqual(3);
				}
				for (const background of [
					'primary',
					'primary-hover',
					'secondary',
					'card',
					'popover',
					'sidebar-primary',
					'sidebar-accent',
				]) {
					expect(
						contrastWCAG21(tokens[background], tokens[`${background}-foreground`]),
					).toBeGreaterThanOrEqual(4.5);
				}
				expect(tokens).not.toHaveProperty('destructive');
			}
			expect(palette.light).not.toEqual(palette.dark);
		},
	);

	it('derives secondary colors from primary and supports secondary-only themes', () => {
		const primaryOnly = generateThemePalette({ primary_color: '#2563eb', secondary_color: null });
		expect(primaryOnly).toEqual(
			generateThemePalette({ primary_color: '#2563eb', secondary_color: '#2563eb' }),
		);
		expect(
			generateThemePalette({ primary_color: null, secondary_color: '#f59e0b' }),
		).not.toBeNull();
	});
	it('treats shorthand, uppercase, and full hex seeds identically', () => {
		const palette = generateThemePalette({ primary_color: '#AbC', secondary_color: '#F00' });
		expect(palette).toEqual(
			generateThemePalette({ primary_color: '#aabbcc', secondary_color: '#ff0000' }),
		);
	});

	it('does not introduce a colored tint into grayscale-only palettes', () => {
		const palette = generateThemePalette({ primary_color: '#000', secondary_color: '#fff' })!;
		for (const tokens of [palette.light, palette.dark]) {
			for (const color of Object.values(tokens)) {
				const [red, green, blue] = to(color, sRGB).coords;
				expect(red).toBeCloseTo(green!, 2);
				expect(red).toBeCloseTo(blue!, 2);
			}
		}
	});
});
