import { useCapabilitiesQuery } from '@/api/hooks';
import { useAuth } from '@/context/AuthContext';

export function useSearchAccess() {
	const { user } = useAuth();
	const allowed = Boolean(user && !user.app_only);
	const capabilities = useCapabilitiesQuery(allowed);
	return {
		user,
		allowed,
		capabilities,
		search: capabilities.data?.search,
		available: allowed && capabilities.isSuccess && Boolean(capabilities.data?.search?.available),
	};
}
