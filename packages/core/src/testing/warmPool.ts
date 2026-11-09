import type { WarmPoolService } from '../services/runtime/WarmPoolService';

/** Reserve then probe, the order session start uses; `undefined` when the pool has no usable member. */
export async function claimWarm(
	service: WarmPoolService,
	request: Parameters<WarmPoolService['reserve']>[0],
) {
	const reserved = await service.reserve(request);
	if (!reserved) return;
	try {
		await service.probe(reserved);
		return reserved;
	} catch {
		return;
	}
}
