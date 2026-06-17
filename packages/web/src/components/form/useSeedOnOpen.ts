import { useEffect } from 'react';
import type { AnyFormApi } from '@tanstack/react-form';

/**
 * Reset (and re-seed) a form each time its dialog opens. Dialogs stay mounted for
 * their exit animation, so without this a cancelled edit leaks into the next open.
 */
export function useSeedOnOpen(form: AnyFormApi, isOpen: boolean, values: Record<string, unknown>) {
	useEffect(() => {
		if (!isOpen) return;
		form.reset(values);
		// reset() clears validation state, so re-run the form schema to refresh
		// canSubmit for the seeded values (errors stay hidden until a field is touched).
		void form.validate('mount');
		// Re-seed only on the open transition; `values`/`form` are stable per open.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isOpen]);
}
