import { expectTypeOf, it } from 'vitest';
import type { operations } from '../../client/src/schema';
import type { IntegrationOutcome, PlannedIntegration } from './index';

type Plan =
	operations['integrations.reconcile.plan']['responses'][200]['content']['application/json']['data'];
type Result =
	operations['integrations.reconcile.apply']['responses'][200]['content']['application/json']['data'];
it('accepts the generated server protocol', () => {
	expectTypeOf<Plan>().toExtend<PlannedIntegration>();
	expectTypeOf<Result>().toExtend<IntegrationOutcome>();
});
