import type {
	IcebergHttpBrokerResponse,
	IcebergHttpBrokerTransportRequest,
} from '@marimo-hub/duckdb-wasm-runtime/node';

export function rangedObjectResponse(
	request: IcebergHttpBrokerTransportRequest,
	bytes: Uint8Array,
	etag: string,
): IcebergHttpBrokerResponse {
	const headers = { etag, 'accept-ranges': 'bytes' };
	const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers?.range ?? '');
	if (!range) {
		return {
			status: 200,
			headers: { ...headers, 'content-length': String(bytes.byteLength) },
			body: request.method === 'HEAD' ? new Uint8Array() : bytes,
		};
	}
	const start = Number(range[1]);
	const end = range[2] ? Math.min(Number(range[2]), bytes.byteLength - 1) : bytes.byteLength - 1;
	if (start >= bytes.byteLength || end < start) {
		return {
			status: 416,
			headers: { ...headers, 'content-range': `bytes */${bytes.byteLength}` },
			body: new Uint8Array(),
		};
	}
	const body = request.method === 'HEAD' ? new Uint8Array() : bytes.slice(start, end + 1);
	return {
		status: 206,
		headers: {
			...headers,
			'content-length': String(end - start + 1),
			'content-range': `bytes ${start}-${end}/${bytes.byteLength}`,
		},
		body,
	};
}
