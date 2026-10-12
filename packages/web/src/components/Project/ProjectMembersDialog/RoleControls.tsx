import { ChevronDown } from 'lucide-react';
import { Tooltip } from '@/components/ui';
import { cn } from '@/lib/utils';
import { ASSIGNABLE_ROLES, roleLabel } from '@/lib/roles';
import { assignableRoleOptions } from './roleOptions';
import type { AssignableProjectRole, ProjectRole } from '@/types';

const ROLE_PILL_CLASS =
	'inline-flex h-7 shrink-0 items-center rounded-full border border-primary/20 bg-primary/10 px-2.5 text-xs font-medium text-primary';

const FOCUS_RING_CLASS = 'outline-none focus-visible:ring-2 focus-visible:ring-ring';

interface RoleBadgeProps {
	value: ProjectRole;
	descriptions: Record<ProjectRole, string>;
	label: string;
	legacyAdmin?: boolean;
}

export function RoleBadge({ value, descriptions, label, legacyAdmin }: RoleBadgeProps) {
	const displayRole = value === 'admin' && legacyAdmin ? 'Admin (legacy)' : roleLabel(value);
	return (
		<Tooltip
			content={
				<div className="flex max-w-72 flex-col gap-1">
					<span className="font-semibold">{displayRole}</span>
					<span>{descriptions[value]}</span>
				</div>
			}
		>
			<button
				type="button"
				aria-label={`${label}: ${displayRole}`}
				className={cn(
					ROLE_PILL_CLASS,
					FOCUS_RING_CLASS,
					'cursor-help transition-colors hover:border-primary/40 hover:bg-primary/15 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
				)}
			>
				{displayRole}
			</button>
		</Tooltip>
	);
}

export function OwnerBadge({ label }: { label: string }) {
	return (
		<span aria-label={`${label}: Owner`} className={ROLE_PILL_CLASS}>
			Owner
		</span>
	);
}

const MEMBER_KINDS = {
	group: {
		text: 'Group',
		tooltip: 'Access applies to everyone whose authenticated IdP groups include this exact ID.',
		label: (id: string) => `IdP group ${id}`,
	},
	invited: {
		text: 'Invited',
		tooltip: 'Invited by email — becomes active when they first sign in',
		label: (id: string) => `Pending invitation for ${id}`,
	},
} as const;

export function MemberKindBadge({ kind, id }: { kind: keyof typeof MEMBER_KINDS; id: string }) {
	const { text, tooltip, label } = MEMBER_KINDS[kind];
	return (
		<Tooltip content={tooltip}>
			<button
				type="button"
				aria-label={label(id)}
				className={cn(
					FOCUS_RING_CLASS,
					'shrink-0 cursor-help rounded-full border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
				)}
			>
				{text}
			</button>
		</Tooltip>
	);
}

interface RoleSelectProps {
	label: string;
	value: ProjectRole;
	onChange: (role: AssignableProjectRole) => void;
	descriptions: Record<ProjectRole, string>;
	disabled?: boolean;
}

export function RoleSelect({ label, value, onChange, descriptions, disabled }: RoleSelectProps) {
	const tooltip = (
		<div className="flex flex-col gap-1">
			{value === 'admin' && (
				<p>
					<span className="font-semibold">admin (legacy)</span> — {descriptions.admin}
				</p>
			)}
			{ASSIGNABLE_ROLES.map((role) => (
				<p key={role}>
					<span className="font-semibold">{role}</span> — {descriptions[role]}
				</p>
			))}
		</div>
	);
	return (
		<span className="relative inline-flex shrink-0 items-center">
			<Tooltip content={tooltip}>
				<select
					aria-label={label}
					value={value}
					onChange={(e) => onChange(e.target.value as AssignableProjectRole)}
					disabled={disabled}
					className="peer h-8 max-sm:h-11 rounded-md border border-input bg-background appearance-none pl-2 pr-8 text-sm text-foreground shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
				>
					{value === 'admin' && (
						<option value="admin" disabled>
							Admin (legacy)
						</option>
					)}
					{assignableRoleOptions}
				</select>
			</Tooltip>
			<ChevronDown
				aria-hidden="true"
				className="pointer-events-none absolute right-2 size-3.5 text-muted-foreground peer-disabled:opacity-50"
			/>
		</span>
	);
}
