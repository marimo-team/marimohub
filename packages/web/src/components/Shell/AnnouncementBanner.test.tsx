import { DEFAULT_THEME_CONFIG } from '@marimo-hub/core/theme';
import { BrandingContext } from '@/context/BrandingContext';
import { afterEach, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithClient, setupUser } from '@/test/render';
import { AnnouncementBanner } from './AnnouncementBanner';

afterEach(() => {
	localStorage.clear();
	vi.restoreAllMocks();
});
it('persists dismissal by ID and shows a new announcement', async () => {
	const announcement = { id: 'a1', text: 'Maintenance Friday', dismissible: true };
	const first = renderWithClient(<AnnouncementBanner />, { branding: { announcement } });
	await setupUser().click(screen.getByRole('button', { name: 'Dismiss announcement' }));
	expect(screen.queryByLabelText('Announcement')).not.toBeInTheDocument();
	first.unmount();
	const second = renderWithClient(<AnnouncementBanner />, { branding: { announcement } });
	expect(screen.queryByText(announcement.text)).not.toBeInTheDocument();
	second.unmount();
	renderWithClient(<AnnouncementBanner />, {
		branding: { announcement: { ...announcement, id: 'a2' } },
	});
	expect(screen.getByText(announcement.text)).toBeInTheDocument();
});
it('renders plain text safely and only offers configured dismissal', () => {
	renderWithClient(<AnnouncementBanner />, {
		branding: {
			announcement: { id: '1', text: '<script>hello</script>', href: '/news', level: 'warning' },
		},
	});
	expect(screen.getByRole('link', { name: '<script>hello</script>' })).toHaveAttribute(
		'href',
		'/news',
	);
	expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
it('works when browser storage is unavailable', async () => {
	vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
		throw new Error('disabled');
	});
	vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
		throw new Error('disabled');
	});
	renderWithClient(<AnnouncementBanner />, {
		branding: { announcement: { id: '1', text: 'News', dismissible: true } },
	});
	await setupUser().click(screen.getByRole('button', { name: 'Dismiss announcement' }));
	expect(screen.queryByText('News')).not.toBeInTheDocument();
});

it('shows a mandatory announcement even if its ID was previously dismissed', () => {
	localStorage.setItem('marimohub-announcement:1', 'dismissed');
	renderWithClient(<AnnouncementBanner />, {
		branding: { announcement: { id: '1', text: 'Required notice', dismissible: false } },
	});
	expect(screen.getByText('Required notice')).toBeInTheDocument();
	expect(screen.queryByRole('button', { name: 'Dismiss announcement' })).not.toBeInTheDocument();
});

it('shows a replacement announcement without remounting the shell', async () => {
	const first = {
		...DEFAULT_THEME_CONFIG,
		announcement: { id: '1', text: 'First', dismissible: true },
	};
	const { rerender } = renderWithClient(
		<BrandingContext value={first}>
			<AnnouncementBanner />
		</BrandingContext>,
	);
	await setupUser().click(screen.getByRole('button', { name: 'Dismiss announcement' }));
	rerender(
		<BrandingContext
			value={{ ...first, announcement: { ...first.announcement, id: '2', text: 'Second' } }}
		>
			<AnnouncementBanner />
		</BrandingContext>,
	);
	expect(screen.getByText('Second')).toBeInTheDocument();
	expect(screen.queryByText('First')).not.toBeInTheDocument();
});

it('does not render a banner when no announcement is configured', () => {
	renderWithClient(<AnnouncementBanner />);
	expect(screen.queryByLabelText('Announcement')).not.toBeInTheDocument();
});
