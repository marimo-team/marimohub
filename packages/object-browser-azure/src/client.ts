import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import {
	AzureAuthorityHosts,
	ClientSecretCredential,
	DefaultAzureCredential,
} from '@azure/identity';
import { BlobServiceClient, StorageSharedKeyCredential } from '@azure/storage-blob';
import type {
	HttpHeaders,
	HttpOperationResponse,
	IHttpClient,
	WebResource,
} from '@azure/storage-blob';
import type { AzureBlobObjectStoreSource, ObjectBrowseContext } from '@marimo-hub/core';
import { ObjectBrowseError } from '@marimo-hub/core';
import {
	createGuardedFetch,
	DEFAULT_OBJECT_BROWSER_LIMITS,
	readBoundedBody,
} from '@marimo-hub/object-browser-commons';
import type { GuardedHostResolver, ObjectBrowserLimits } from '@marimo-hub/object-browser-commons';

export type AzureResponseLimits = Pick<
	ObjectBrowserLimits,
	'metadataMaxResponseBytes' | 'listMaxResponseBytes'
>;

export function createAzureClient(
	source: AzureBlobObjectStoreSource,
	context: ObjectBrowseContext,
	resolveHost: GuardedHostResolver,
	fetchImpl: typeof fetch,
	limits: AzureResponseLimits = DEFAULT_OBJECT_BROWSER_LIMITS,
): BlobServiceClient {
	const options = {
		httpClient: guardedHttpClient(resolveHost, fetchImpl, context.signal, limits),
	};
	const authorityHost = authorityHostFor(source.endpoint_suffix);
	if (source.auth.method === 'connection_string') {
		return BlobServiceClient.fromConnectionString(source.auth.connection_string, options);
	}
	const accountUrl = `https://${source.account_name}.blob.${source.endpoint_suffix}`;
	if (source.auth.method === 'account_key') {
		return new BlobServiceClient(
			accountUrl,
			new StorageSharedKeyCredential(source.account_name, source.auth.account_key),
			options,
		);
	}
	if (source.auth.method === 'sas_token') {
		const token = source.auth.sas_token.replace(/^\?/, '');
		return new BlobServiceClient(`${accountUrl}?${token}`, undefined, options);
	}
	if (source.auth.method === 'service_principal') {
		return new BlobServiceClient(
			accountUrl,
			new ClientSecretCredential(
				source.auth.tenant_id,
				source.auth.client_id,
				source.auth.client_secret,
				{ authorityHost },
			),
			options,
		);
	}
	if (!context.allow_server_ambient.azure_blob) {
		throw new ObjectBrowseError(
			'access_denied',
			'Ambient Azure Blob access is not enabled for this integration.',
		);
	}
	return new BlobServiceClient(accountUrl, new DefaultAzureCredential({ authorityHost }), options);
}

function authorityHostFor(endpointSuffix: string): string {
	switch (endpointSuffix) {
		case 'core.chinacloudapi.cn':
			return AzureAuthorityHosts.AzureChina;
		case 'core.usgovcloudapi.net':
			return AzureAuthorityHosts.AzureGovernment;
		default:
			return AzureAuthorityHosts.AzurePublicCloud;
	}
}

export function guardedHttpClient(
	resolveHost: GuardedHostResolver,
	fetchImpl: typeof fetch,
	contextSignal?: AbortSignal,
	limits: AzureResponseLimits = DEFAULT_OBJECT_BROWSER_LIMITS,
): IHttpClient {
	const pinnedFetch = fetchImpl === fetch ? createGuardedFetch(resolveHost) : fetchImpl;
	return {
		async sendRequest(request: WebResource): Promise<HttpOperationResponse> {
			const controller = new AbortController();
			const abort = () => controller.abort();
			const signals = [contextSignal, request.abortSignal].filter(
				(signal): signal is NonNullable<typeof signal> => signal !== undefined,
			);
			const cleanup = () => {
				for (const signal of signals) signal.removeEventListener('abort', abort);
			};
			let streaming = false;
			if (signals.some((signal) => signal.aborted)) abort();
			else for (const signal of signals) signal.addEventListener('abort', abort);
			try {
				const url = new URL(request.url);
				if (fetchImpl !== fetch) await resolveHost(url.hostname, controller.signal);
				const response = await pinnedFetch(url, {
					method: request.method,
					headers: request.headers.toJson({ preserveCase: true }),
					body: request.body as BodyInit | null | undefined,
					signal: controller.signal,
					redirect: 'error',
				});
				const headers = compatHeaders(response.headers);
				const stream = request.streamResponseStatusCodes?.has(response.status);
				if (stream && response.body) {
					streaming = true;
					const readable = Readable.fromWeb(response.body as NodeReadableStream);
					readable.once('close', cleanup);
					return { request, status: response.status, headers, readableStreamBody: readable };
				}
				// List Blobs XML has no field projection, so a full page of
				// max-length names needs far more room than other metadata calls.
				const maxResponseBytes =
					url.searchParams.get('comp') === 'list'
						? limits.listMaxResponseBytes
						: limits.metadataMaxResponseBytes;
				return {
					request,
					status: response.status,
					headers,
					bodyAsText: response.body
						? new TextDecoder().decode(await readBoundedBody(response.body, maxResponseBytes))
						: '',
				};
			} catch (error) {
				if ((error as { name?: unknown } | null)?.name === 'AbortError') {
					throw new ObjectBrowseError('aborted', 'The request was canceled.');
				}
				if (error instanceof ObjectBrowseError) throw error;
				throw new ObjectBrowseError('unavailable', 'The Azure Blob request failed.');
			} finally {
				if (!streaming) cleanup();
			}
		},
	};
}

function compatHeaders(source: Headers): HttpHeaders {
	const values = new Map<string, { name: string; value: string }>();
	source.forEach((value, name) => values.set(name.toLowerCase(), { name, value }));
	const headers: HttpHeaders = {
		set(name, value) {
			values.set(name.toLowerCase(), { name, value: String(value) });
		},
		get(name) {
			return values.get(name.toLowerCase())?.value;
		},
		contains(name) {
			return values.has(name.toLowerCase());
		},
		remove(name) {
			return values.delete(name.toLowerCase());
		},
		rawHeaders() {
			return Object.fromEntries([...values.values()].map(({ name, value }) => [name, value]));
		},
		headersArray() {
			return [...values.values()];
		},
		headerNames() {
			return [...values.values()].map(({ name }) => name);
		},
		headerValues() {
			return [...values.values()].map(({ value }) => value);
		},
		clone() {
			return compatHeaders(new Headers(headers.rawHeaders()));
		},
		toJson() {
			return headers.rawHeaders();
		},
	};
	return headers;
}
