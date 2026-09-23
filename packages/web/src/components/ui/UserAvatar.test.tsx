import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_THEME_CONFIG } from '@marimo-hub/core/theme';
import { BrandingContext } from '@/context/BrandingContext';
import { UserAvatar } from './UserAvatar';

const FIRST_URL = 'https://identity.example/avatar/first.png';
const SECOND_URL = 'https://identity.example/avatar/second.png';

function image(): HTMLImageElement | null {
	return document.querySelector('img');
}

describe('UserAvatar', () => {
	it('uses the teal gradient with default branding', () => {
		render(<UserAvatar label="Ada" />);

		expect(screen.getByText('A')).toHaveClass('from-teal-500/15', 'to-teal-600/25');
		expect(screen.getByText('A')).not.toHaveClass('from-primary/15', 'to-primary/25');
	});

	it.each([
		{ primary_color: '#345678' },
		{ secondary_color: '#abcdef' },
		{ primary_color: '#345678', secondary_color: '#abcdef' },
	])('uses the theme gradient with custom colors %j', (colors) => {
		render(
			<BrandingContext value={{ ...DEFAULT_THEME_CONFIG, ...colors }}>
				<UserAvatar label="Ada" />
			</BrandingContext>,
		);

		expect(screen.getByText('A')).toHaveClass('from-primary/15', 'to-primary/25');
		expect(screen.getByText('A')).not.toHaveClass('from-teal-500/15', 'to-teal-600/25');
	});

	it('renders the identity-provider picture with privacy attributes', () => {
		render(<UserAvatar pictureUrl={FIRST_URL} label="Ada" />);

		expect(image()).toHaveAttribute('src', FIRST_URL);
		expect(image()).toHaveAttribute('alt', '');
		expect(image()).toHaveAttribute('referrerpolicy', 'no-referrer');
	});

	it('falls back to the initial when the picture fails', () => {
		render(<UserAvatar pictureUrl={FIRST_URL} label="Ada" />);

		fireEvent.error(image()!);

		expect(image()).not.toBeInTheDocument();
		expect(screen.getByText('A')).toBeInTheDocument();
	});

	it('does not retry a failed picture during unrelated rerenders', () => {
		const view = render(<UserAvatar pictureUrl={FIRST_URL} label="Ada" />);
		fireEvent.error(image()!);

		view.rerender(<UserAvatar pictureUrl={FIRST_URL} label="Alice" className="size-8" />);

		expect(image()).not.toBeInTheDocument();
		expect(screen.getByText('A')).toBeInTheDocument();
	});

	it('tries a new URL after the previous URL fails', () => {
		const view = render(<UserAvatar pictureUrl={FIRST_URL} label="Ada" />);
		fireEvent.error(image()!);

		view.rerender(<UserAvatar pictureUrl={SECOND_URL} label="Ada" />);

		expect(image()).toHaveAttribute('src', SECOND_URL);
	});

	it('retries a failed URL after the URL changes away and back', () => {
		const view = render(<UserAvatar pictureUrl={FIRST_URL} label="Ada" />);
		fireEvent.error(image()!);

		view.rerender(<UserAvatar pictureUrl={SECOND_URL} label="Ada" />);
		view.rerender(<UserAvatar pictureUrl={FIRST_URL} label="Ada" />);

		expect(image()).toHaveAttribute('src', FIRST_URL);
	});

	it('ignores an error from an image removed by a URL change', () => {
		const view = render(<UserAvatar pictureUrl={FIRST_URL} label="Ada" />);
		const removedImage = image()!;

		view.rerender(<UserAvatar pictureUrl={SECOND_URL} label="Ada" />);
		fireEvent.error(removedImage);

		expect(image()).toHaveAttribute('src', SECOND_URL);
	});

	it.each([undefined, null, ''] as const)('uses the initial without a picture URL (%s)', (url) => {
		render(<UserAvatar pictureUrl={url} label="ada" />);

		expect(image()).not.toBeInTheDocument();
		expect(screen.getByText('A')).toBeInTheDocument();
	});

	it('uses the first trimmed Unicode code point as the initial', () => {
		render(<UserAvatar label="  🐍 developer" />);

		expect(screen.getByText('🐍')).toBeInTheDocument();
		expect(screen.queryByText('\uFFFD')).not.toBeInTheDocument();
	});

	it('preserves an astral initial after the picture fails', () => {
		render(<UserAvatar pictureUrl={FIRST_URL} label="🦊 Fox" />);

		fireEvent.error(image()!);

		expect(screen.getByText('🦊')).toBeInTheDocument();
	});

	it('renders no initial for a whitespace-only label', () => {
		const { container } = render(<UserAvatar label="   " />);

		expect(container.querySelector('span')).toBeEmptyDOMElement();
	});
});
