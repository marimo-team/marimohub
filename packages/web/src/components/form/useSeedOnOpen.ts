import { useEffect, useRef } from 'react';
import type { AnyFormApi } from '@tanstack/react-form';

/**
 * Reset (and re-seed) a form each time its dialog opens. Dialogs stay mounted for
 * their exit animation, so without this a cancelled edit leaks into the next open.
 *
 * `values` must be what the form was given as `defaultValues` for that render.
 * `useForm` re-runs `formApi.update(opts)` in a layout effect on every render,
 * and that writes `opts.defaultValues` back over an *untouched* form — so a seed
 * drawn from anywhere else is silently reverted on the next commit. Re-seeding a
 * touched form, the reopen case this hook exists for, is unaffected.
 */
export function useSeedOnOpen(form: AnyFormApi, isOpen: boolean, values: Record<string, unknown>) {
	const wasOpen = useRef(false);
	useEffect(() => {
		const opening = isOpen && !wasOpen.current;
		wasOpen.current = isOpen;
		if (!opening) return;
		form.reset(values);
		// reset() clears validation state, so re-run the form schema to refresh
		// canSubmit for the seeded values (errors stay hidden until a field is touched).
		void form.validate('mount');
	}, [form, isOpen, values]);
}
