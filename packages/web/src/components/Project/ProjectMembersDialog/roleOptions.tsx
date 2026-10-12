import { ASSIGNABLE_ROLES, roleLabel } from '@/lib/roles';

// Kept out of the component modules so Fast Refresh can preserve their state.
export const assignableRoleOptions = ASSIGNABLE_ROLES.map((role) => (
	<option key={role} value={role}>
		{roleLabel(role)}
	</option>
));
