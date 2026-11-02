import { useQuery } from '@tanstack/react-query';
import { useMatch } from 'react-router-dom';
import type { ThemeLinkRole, ThemeNavLink } from '@marimo-hub/core/theme';
import { useUserQuery, useCapabilitiesQuery, projectQueryOptions } from '@/api/hooks';
import { useBranding } from '@/context/BrandingContext';

export function useShellLinks(placement: 'header' | 'help', projectRole?: ThemeLinkRole) {
	const { nav_links } = useBranding();
	const match = useMatch('/projects/:pid/*');
	const { data: user } = useUserQuery();
	const needsRole = (nav_links ?? []).some((link) => link.roles !== undefined);
	const { data: capabilities } = useCapabilitiesQuery(!!user && needsRole && !projectRole);
	const { data: project } = useQuery({
		...projectQueryOptions(match?.params.pid ?? ''),
		enabled: !!user && !user.app_only && needsRole && !!match?.params.pid && !projectRole,
	});
	const role = user?.is_super_admin
		? 'admin'
		: (projectRole ??
			(user?.app_only
				? 'app-user'
				: match?.params.pid
					? project?.your_role
					: capabilities?.default_role));
	return (nav_links ?? [])
		.map((link, index) => ({ ...link, id: `custom-${index}-${link.href}` }))
		.filter(
			(link) =>
				(link.placement ?? 'header') === placement &&
				(!link.roles || (!!user && !!role && link.roles.includes(role))),
		);
}

export function shellLinkTarget(link: Pick<ThemeNavLink, 'href' | 'external'>) {
	return (link.external ?? /^https:\/\//i.test(link.href)) ? '_blank' : undefined;
}
