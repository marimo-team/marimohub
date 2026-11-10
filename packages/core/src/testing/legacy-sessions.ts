import type { Bucket } from '../ports/bucket';
import { paths } from '../paths';
import { MemoryBucket } from './MemoryBucket';
import { SessionService } from '../services/runtime/SessionService';
import type { CreateSessionInput } from '../services/runtime/SessionService';

/** Seed pre-index records without a production switch that disables registration. */
export function legacySessions(bucket: Bucket) {
	const sessions = new SessionService(bucket);
	return {
		async createSession(input: CreateSessionInput) {
			const session = await new SessionService(new MemoryBucket()).createSession(input);
			await bucket.put(
				paths.session(session.project_id, session.session_id),
				JSON.stringify(session),
			);
			return session;
		},
		setRunning: sessions.setRunning.bind(sessions),
	};
}
