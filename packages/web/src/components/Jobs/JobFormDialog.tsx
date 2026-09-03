import { z } from 'zod';
import { toast } from 'sonner';
import {
	FormDialog,
	requiredText,
	schemaValidators,
	useAppForm,
	useSeedOnOpen,
} from '@/components/form';
import { useCapabilitiesQuery, useCreateJob, useUpdateJob } from '@/api/hooks';
import { toastError } from '@/lib/errors';
import { formatJobParameters, parseJobParameters } from '@/lib/jobs';
import type { Job, JobCreateBody, JobUpdateBody } from '@/types';

const MIN_TIMEOUT_SECONDS = 60;

type JobFormValues = {
	name: string;
	enabled: boolean;
	scheduled: boolean;
	cron: string;
	timezone: string;
	timeoutSeconds: string;
	parameters: string;
	maxRetries: string;
	backoffSeconds: string;
	concurrencyPolicy: Job['concurrency_policy'];
	notifyFailure: boolean;
	notifySuccess: boolean;
};

const baseSchema = z.object({
	name: requiredText('Name'),
	enabled: z.boolean(),
	scheduled: z.boolean(),
	cron: z.string().trim(),
	timezone: z.string().trim(),
	timeoutSeconds: z.string().trim().regex(/^\d*$/, 'Whole seconds only'),
	parameters: z.string(),
	maxRetries: z
		.string()
		.trim()
		.regex(/^[0-5]$/, 'Between 0 and 5'),
	backoffSeconds: z.string().trim(),
	concurrencyPolicy: z.enum(['forbid', 'allow', 'unknown']),
	notifyFailure: z.boolean(),
	notifySuccess: z.boolean(),
});

function jobFormSchema(maxTimeout: number | null | undefined) {
	return baseSchema.superRefine((values, ctx) => {
		if (values.scheduled) {
			if (!values.cron)
				ctx.addIssue({ code: 'custom', path: ['cron'], message: 'Cron expression is required' });
			if (!values.timezone)
				ctx.addIssue({ code: 'custom', path: ['timezone'], message: 'Time zone is required' });
		}
		if (values.timeoutSeconds && Number(values.timeoutSeconds) < MIN_TIMEOUT_SECONDS) {
			ctx.addIssue({
				code: 'custom',
				path: ['timeoutSeconds'],
				message: `At least ${MIN_TIMEOUT_SECONDS} seconds`,
			});
		}
		if (maxTimeout != null && values.timeoutSeconds && Number(values.timeoutSeconds) > maxTimeout) {
			ctx.addIssue({
				code: 'custom',
				path: ['timeoutSeconds'],
				message: `At most ${maxTimeout} seconds`,
			});
		}
		if (Number(values.maxRetries) > 0) {
			if (!/^\d{1,4}$/.test(values.backoffSeconds)) {
				ctx.addIssue({
					code: 'custom',
					path: ['backoffSeconds'],
					message: 'Whole seconds, at most 3600',
				});
			} else if (Number(values.backoffSeconds) > 3600) {
				ctx.addIssue({ code: 'custom', path: ['backoffSeconds'], message: 'At most 3600 seconds' });
			}
		}
		if (values.concurrencyPolicy === 'unknown') {
			ctx.addIssue({
				code: 'custom',
				path: ['concurrencyPolicy'],
				message: 'Choose a supported concurrency policy',
			});
		}
		try {
			parseJobParameters(values.parameters);
		} catch (err) {
			ctx.addIssue({
				code: 'custom',
				path: ['parameters'],
				message: err instanceof Error ? err.message : 'Invalid parameters',
			});
		}
	});
}

function localTimeZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	} catch {
		return 'UTC';
	}
}

function seedValues(job: Job | null | undefined): JobFormValues {
	return {
		name: job?.name ?? '',
		enabled: job?.enabled ?? true,
		scheduled: !!job?.schedule,
		cron: job?.schedule?.cron ?? '0 6 * * *',
		timezone: job?.schedule?.timezone ?? localTimeZone(),
		timeoutSeconds: job?.timeout_seconds !== undefined ? String(job.timeout_seconds) : '',
		parameters: formatJobParameters(job?.parameters),
		maxRetries: String(job?.retry?.max_retries ?? 0),
		backoffSeconds: String(job?.retry?.backoff_seconds ?? 60),
		concurrencyPolicy: job?.concurrency_policy ?? 'forbid',
		notifyFailure: job?.notifications?.on.includes('failure') ?? false,
		notifySuccess: job?.notifications?.on.includes('success') ?? false,
	};
}

/** The create body, with each optional section present only when set. */
function toCreateBody(values: JobFormValues): JobCreateBody {
	const parameters = parseJobParameters(values.parameters);
	const maxRetries = Number(values.maxRetries);
	const on = [
		...(values.notifyFailure ? (['failure'] as const) : []),
		...(values.notifySuccess ? (['success'] as const) : []),
	];
	return {
		name: values.name.trim(),
		enabled: values.enabled,
		...(values.scheduled
			? { schedule: { cron: values.cron.trim(), timezone: values.timezone.trim() } }
			: {}),
		...(Object.keys(parameters).length > 0 ? { parameters } : {}),
		...(maxRetries > 0
			? { retry: { max_retries: maxRetries, backoff_seconds: Number(values.backoffSeconds) } }
			: {}),
		...(values.timeoutSeconds ? { timeout_seconds: Number(values.timeoutSeconds) } : {}),
		concurrency_policy: supportedConcurrencyPolicy(values.concurrencyPolicy),
		...(on.length > 0 ? { notifications: { on: [...on] } } : {}),
	};
}

function supportedConcurrencyPolicy(policy: Job['concurrency_policy']): 'forbid' | 'allow' {
	if (policy === 'unknown') throw new Error('Choose a supported concurrency policy');
	return policy;
}

/** The update body: every optional section is sent, `null` clearing what the form left empty. */
function toUpdateBody(values: JobFormValues): JobUpdateBody {
	const body = toCreateBody(values);
	return {
		name: body.name,
		enabled: body.enabled,
		schedule: body.schedule ?? null,
		parameters: body.parameters ?? null,
		retry: body.retry ?? null,
		timeout_seconds: body.timeout_seconds ?? null,
		concurrency_policy: body.concurrency_policy,
		notifications: body.notifications ?? null,
	};
}

interface JobFormDialogProps {
	isOpen: boolean;
	onClose: () => void;
	projectId: string;
	notebookId: string;
	/** Edit this job; absent = create. */
	job?: Job | null;
	onSaved?: (job: Job) => void;
}

export function JobFormDialog({
	isOpen,
	onClose,
	projectId,
	notebookId,
	job,
	onSaved,
}: JobFormDialogProps) {
	const { data: capabilities } = useCapabilitiesQuery();
	const alertsAvailable = capabilities?.project_alerts.available ?? false;
	const maxTimeout = capabilities?.jobs?.max_timeout_seconds;
	const defaultTimeout = capabilities?.jobs?.default_timeout_seconds;
	const create = useCreateJob(projectId, notebookId);
	const update = useUpdateJob(projectId, notebookId);
	const seed = seedValues(job);
	const form = useAppForm({
		defaultValues: seed,
		validators: schemaValidators(jobFormSchema(maxTimeout)),
		onSubmit: async ({ value }) => {
			try {
				const saved = job
					? await update.mutateAsync({
							jobId: job.id,
							updatedAt: job.updated_at,
							...toUpdateBody(value),
						})
					: await create.mutateAsync(toCreateBody(value));
				toast.success(job ? 'Job updated' : 'Job created');
				onSaved?.(saved);
				onClose();
			} catch (err) {
				toastError(err);
			}
		},
	});
	useSeedOnOpen(form, isOpen, seed);

	return (
		<FormDialog
			form={form}
			isPending={create.isPending || update.isPending}
			isOpen={isOpen}
			onClose={onClose}
			title={job ? 'Edit job' : 'New job'}
			submitLabel={job ? 'Save' : 'Create job'}
			pendingLabel="Saving…"
			width="form"
		>
			<form.AppField name="name">
				{(field) => <field.TextField label="Name" placeholder="Nightly refresh" autoFocus />}
			</form.AppField>
			<form.AppField name="enabled">
				{(field) => (
					<field.SwitchField>
						{(on) => (
							<span className="text-sm">
								{on ? 'Enabled' : 'Disabled — never fires, can still be run manually'}
							</span>
						)}
					</field.SwitchField>
				)}
			</form.AppField>

			<fieldset className="flex flex-col gap-3 rounded-md border border-border p-3">
				<legend className="px-1 text-xs font-medium text-muted-foreground">Schedule</legend>
				<form.AppField name="scheduled">
					{(field) => (
						<field.SwitchField>
							{(on) => (
								<span className="text-sm">{on ? 'Run on a schedule' : 'Manual runs only'}</span>
							)}
						</field.SwitchField>
					)}
				</form.AppField>
				<form.Subscribe selector={(state) => state.values.scheduled}>
					{(scheduled) =>
						scheduled ? (
							<div className="grid gap-3 sm:grid-cols-2">
								<form.AppField name="cron">
									{(field) => (
										<field.TextField
											label="Cron (min hour day month weekday)"
											placeholder="0 6 * * 1-5"
										/>
									)}
								</form.AppField>
								<form.AppField name="timezone">
									{(field) => (
										<field.TextField label="Time zone (IANA)" placeholder="Europe/Berlin" />
									)}
								</form.AppField>
							</div>
						) : null
					}
				</form.Subscribe>
			</fieldset>

			<form.AppField name="parameters">
				{(field) => (
					<label className="flex flex-col gap-1.5">
						<span className="text-xs font-medium text-muted-foreground">
							Parameters (one <code>key=value</code> per line; quote whitespace with JSON)
						</span>
						<textarea
							aria-label="Parameters"
							value={field.state.value}
							onChange={(event) => field.handleChange(event.target.value)}
							onBlur={field.handleBlur}
							rows={3}
							spellCheck={false}
							placeholder={'region=eu-west-1\nlimit=100'}
							className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						/>
						{field.state.meta.isTouched && field.state.meta.errors[0] && (
							<span className="text-xs text-destructive">
								{typeof field.state.meta.errors[0] === 'string'
									? field.state.meta.errors[0]
									: (field.state.meta.errors[0] as { message: string }).message}
							</span>
						)}
					</label>
				)}
			</form.AppField>

			<div className="grid gap-3 sm:grid-cols-[minmax(12rem,1.2fr)_minmax(0,1fr)_minmax(0,1fr)]">
				<form.AppField name="timeoutSeconds">
					{(field) => (
						<field.TextField
							label={maxTimeout ? `Timeout (seconds, up to ${maxTimeout})` : 'Timeout (seconds)'}
							placeholder={defaultTimeout ? `${defaultTimeout} (default)` : 'default'}
						/>
					)}
				</form.AppField>
				<form.AppField name="maxRetries">
					{(field) => <field.TextField label="Retries on failure" placeholder="0" />}
				</form.AppField>
				<form.AppField name="backoffSeconds">
					{(field) => <field.TextField label="Retry backoff (seconds)" placeholder="60" />}
				</form.AppField>
			</div>

			<form.AppField name="concurrencyPolicy">
				{(field) => (
					<field.RadioGroupField
						label="If the previous run is still active"
						options={[
							{
								value: 'forbid',
								label: 'Skip this fire',
								description: 'The scheduled occurrence is recorded as skipped.',
							},
							{
								value: 'allow',
								label: 'Run anyway',
								description: 'Runs overlap, each in its own sandbox.',
							},
						]}
					/>
				)}
			</form.AppField>
			<form.Subscribe selector={(state) => state.values.concurrencyPolicy}>
				{(policy) =>
					policy === 'unknown' ? (
						<p className="text-xs text-destructive">
							This job uses an unsupported concurrency policy. Choose one before saving.
						</p>
					) : null
				}
			</form.Subscribe>

			{alertsAvailable && (
				<fieldset className="flex flex-col gap-2 rounded-md border border-border p-3">
					<legend className="px-1 text-xs font-medium text-muted-foreground">Project alerts</legend>
					<form.AppField name="notifyFailure">
						{(field) => (
							<field.SwitchField>
								{() => <span className="text-sm">Notify when a run fails (after retries)</span>}
							</field.SwitchField>
						)}
					</form.AppField>
					<form.AppField name="notifySuccess">
						{(field) => (
							<field.SwitchField>
								{() => <span className="text-sm">Notify when a run succeeds</span>}
							</field.SwitchField>
						)}
					</form.AppField>
					<p className="text-xs text-muted-foreground">
						Delivered to the project’s alert destinations subscribed to job events.
					</p>
				</fieldset>
			)}
		</FormDialog>
	);
}
