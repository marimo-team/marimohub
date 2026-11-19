import type { PoolClient } from 'pg';
import type { TransferIdentity, TransferLease } from './transferState';

export async function withTransferLease<T>(
	client: PoolClient,
	identity: TransferIdentity,
	lease: TransferLease,
	work: () => Promise<T>,
): Promise<T> {
	// The caller holds FOR UPDATE after checking a live lease. That lock prevents
	// takeover even if the deadline passes while a slow object-store read finishes.
	const renew = async () => {
		const result = await client.query(
			`UPDATE hub_metadata.transfers SET lease_until=clock_timestamp()+interval '60 seconds'
			WHERE namespace=$1 AND id=$2 AND lease_id=$3 AND revision=$4 AND state IN ('copying','checking')`,
			[identity.namespace, identity.id, lease.lease_id, lease.revision],
		);
		if (result.rowCount !== 1) throw new Error('Transfer lease lost during reference audit');
	};
	await renew();
	let stopped = false;
	let failure: Error | undefined;
	let pending = Promise.resolve();
	let timer: ReturnType<typeof setTimeout>;
	const heartbeat = () => {
		pending = renew()
			.catch((error: unknown) => {
				failure = error instanceof Error ? error : new Error('Transfer lease renewal failed');
			})
			.finally(() => {
				if (!stopped && !failure) timer = setTimeout(heartbeat, 5000);
			});
	};
	// Periodic queries also keep slow artifact reads below the connection's idle timeout.
	timer = setTimeout(heartbeat, 5000);
	let result: T;
	try {
		result = await work();
	} finally {
		stopped = true;
		clearTimeout(timer);
		await pending;
	}
	if (failure) throw failure;
	await renew();
	return result;
}
