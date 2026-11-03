import { useQuery } from '@tanstack/react-query';
import type { ThemeLinkRole, ThemeNavLink } from '@marimo-hub/core/theme';
import { useUserQuery, useCapabilitiesQuery, projectQueryOptions } from '@/api/hooks';
import { useBranding } from '@/context/BrandingContext';
import { useWorkspaceRoute } from '@/components/Workspace/navigation';

export function useShellLinks(placement: 'header' | 'help', projectRole?: ThemeLinkRole) {
	const { nav_links } = useBranding();
	const { pid } = useWorkspaceRoute();
	const { data: user } = useUserQuery();
	const needsRole = (nav_links ?? []).some((link) => link.roles !== undefined);
	const capabilities = useCapabilitiesQuery(!!user && needsRole && !projectRole);
	const project = useQuery({
		...projectQueryOptions(pid ?? ''),
		enabled: !!user && !user.app_only && needsRole && !!pid && !projectRole,
	});
	const resolvedRole = pid
		? project.isError
			? undefined
			: project.data?.your_role
		: capabilities.isError
			? undefined
			: capabilities.data?.default_role;
	const role = user?.is_super_admin
		? 'admin'
		: (projectRole ?? (user?.app_only ? 'app-user' : resolvedRole));
	const links: (ThemeNavLink & { id: string })[] = [];
	for (const [index, link] of (nav_links ?? []).entries()) {
		if (
			(link.placement ?? 'header') === placement &&
			(!link.roles || (!!user && !!role && link.roles.includes(role)))
		) {
			links.push({ ...link, id: `custom-${index}-${link.href}` });
		}
	}
	return links;
}

export function shellLinkTarget(link: Pick<ThemeNavLink, 'href' | 'external'>) {
	return (link.external ?? /^https:\/\//i.test(link.href)) ? '_blank' : undefined;
}
