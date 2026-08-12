import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectId, UserId } from '@marimo-hub/core';
import type { ObjectBrowseContext, ObjectStoreSource } from '@marimo-hub/core';
import type { AsyncBuffer } from 'hyparquet';
import type { S3ClientLike } from '../client';
import { S3ObjectBrowser } from '../index';

const parquet = vi.hoisted(() => ({
	metadata: vi.fn(),
	read: vi.fn(),
	schema: vi.fn(),
}));

vi.mock('hyparquet', () => ({
	parquetMetadataAsync: parquet.metadata,
	parquetReadObjects: parquet.read,
	parquetSchema: parquet.schema,
}));

const source: ObjectStoreSource = {
	provider: 's3',
	configured_bucket: 'lake',
	path_style: false,
	auth: {
		method: 'static',
		access_key_id: 'access',
		secret_access_key: 'secret',
	},
};

const context: ObjectBrowseContext = {
	project_id: createProjectId(),
	user_id: UserId.parse('user-1'),
	user_email: 'ada@example.com',
	allow_server_ambient: false,
};

beforeEach(() => {
	parquet.metadata.mockReset();
	parquet.read.mockReset();
	parquet.schema.mockReset();
});

describe('preview format boundaries', () => {
	it.each([
		['page.html', 'text/html'],
		['page.xhtml', 'application/xhtml+xml'],
		['image.svg', 'image/svg+xml'],
		['report.pdf', 'application/pdf'],
	])('does not render active content for %s', async (key, contentType) => {
		const bytes = new TextEncoder().encode('unsafe');
		const test = harness([
			{ ContentLength: bytes.length, ContentType: `${contentType}; charset=utf-8` },
			{ Body: body(bytes) },
		]);
		await expect(test.preview(key)).resolves.toMatchObject({
			kind: 'unsupported',
			detected_type: contentType,
		});
		expect(test.destroyed()).toBe(1);
	});

	it.each([
		['readme.md', 'markdown'],
		['service.log', 'log'],
		['query.sql', 'code'],
		['notes.txt', 'text'],
	])('classifies %s as safe %s text', async (key, format) => {
		const bytes = new TextEncoder().encode('hello');
		const test = harness([{ ContentLength: bytes.length }, { Body: body(bytes) }]);
		await expect(test.preview(key)).resolves.toMatchObject({
			kind: 'text',
			format,
			text: 'hello',
			truncated: false,
		});
	});

	it('truncates large text to the text-specific limit', async () => {
		const bytes = new Uint8Array(512 * 1024 + 1).fill(0x61);
		const test = harness([{ ContentLength: bytes.length }, { Body: body(bytes) }]);
		const preview = await test.preview('large.txt');
		expect(preview).toMatchObject({
			kind: 'text',
			truncated: true,
			bytes_read: bytes.length,
			total_bytes: bytes.length,
		});
		if (preview.kind !== 'text') throw new Error('Expected text preview.');
		expect(preview.text).toHaveLength(512 * 1024);
	});

	it.each([
		{
			key: 'notes.txt',
			contentType: 'text/plain',
			full: 'ok€rest',
			prefix: new Uint8Array([0x6f, 0x6b, 0xe2, 0x82]),
			expected: { kind: 'text', text: 'ok', truncated: true },
		},
		{
			key: 'people.csv',
			contentType: 'text/csv',
			full: 'name\nAda\nZoë\n',
			prefix: new Uint8Array([...new TextEncoder().encode('name\nAda\nZo'), 0xc3]),
			expected: { kind: 'tabular', rows: [['Ada']], truncated: true },
		},
		{
			key: 'people.jsonl',
			contentType: 'application/x-ndjson',
			full: '{"name":"Ada"}\n{"name":"Zoë"}\n',
			prefix: new Uint8Array([...new TextEncoder().encode('{"name":"Ada"}\n{"name":"Zo'), 0xc3]),
			expected: { kind: 'tabular', rows: [['Ada']], truncated: true },
		},
	])('drops an incomplete trailing UTF-8 code point in $key', async (fixture) => {
		const total = new TextEncoder().encode(fixture.full).length;
		const test = harness(
			[{ ContentLength: total, ContentType: fixture.contentType }, { Body: body(fixture.prefix) }],
			{ previewMaxBytes: fixture.prefix.length },
		);
		await expect(test.preview(fixture.key)).resolves.toMatchObject(fixture.expected);
	});

	it('still rejects invalid UTF-8 inside a truncated prefix', async () => {
		const bytes = new Uint8Array([0x61, 0xff, 0xe2]);
		const test = harness(
			[{ ContentLength: bytes.length + 10, ContentType: 'text/plain' }, { Body: body(bytes) }],
			{ previewMaxBytes: bytes.length },
		);
		await expect(test.preview('bad.txt')).rejects.toMatchObject({ code: 'unsupported' });
	});

	it('uses one value column for mixed JSON arrays and truncates top-level objects by row limit', async () => {
		const mixed = new TextEncoder().encode('[1,{"x":2},null]');
		const mixedTest = harness([
			{ ContentLength: mixed.length, ContentType: 'application/json' },
			{ Body: body(mixed) },
		]);
		await expect(mixedTest.preview('mixed.json', 2)).resolves.toMatchObject({
			kind: 'tabular',
			columns: [{ name: 'value' }],
			rows: [[1], ['{"x":2}']],
			truncated: true,
		});

		const object = new TextEncoder().encode('{"one":1,"two":2}');
		const objectTest = harness([
			{ ContentLength: object.length, ContentType: 'application/json' },
			{ Body: body(object) },
		]);
		await expect(objectTest.preview('object.json', 1)).resolves.toMatchObject({
			kind: 'tabular',
			rows: [['one', 1]],
			truncated: true,
		});
	});

	it.each([
		['array', '[{"x":1}]   ', { kind: 'tabular', rows: [[1]] }],
		['object', '{"x":1}   ', { kind: 'tabular', rows: [['x', 1]] }],
		['scalar', '42   ', { kind: 'text', text: '42' }],
	] as const)(
		'marks a byte-truncated but parseable JSON %s as truncated',
		async (_name, json, expected) => {
			const bytes = new TextEncoder().encode(json);
			const test = harness(
				[
					{ ContentLength: bytes.length + 10, ContentType: 'application/json' },
					{ Body: body(bytes) },
				],
				{ previewMaxBytes: bytes.length },
			);
			await expect(test.preview('data.json')).resolves.toMatchObject({
				...expected,
				truncated: true,
			});
		},
	);

	it('bounds CSV fields before normalizing excluded columns', async () => {
		const headers = Array.from({ length: 201 }, (_, index) => `c${index}`);
		const row = [...Array.from({ length: 200 }, () => 'ok'), 'x'.repeat(9 * 1024)];
		const bytes = new TextEncoder().encode(`${headers.join(',')}\n${row.join(',')}\n`);
		const test = harness([
			{ ContentLength: bytes.length, ContentType: 'text/csv' },
			{ Body: body(bytes) },
		]);
		const preview = await test.preview('wide.csv');
		expect(preview).toMatchObject({ kind: 'tabular', truncated: true, warnings: [] });
		if (preview.kind !== 'tabular') throw new Error('Expected tabular preview.');
		expect(preview.columns).toHaveLength(200);
		expect(preview.rows[0]).toHaveLength(200);
	});

	it('enforces the tabular response limit in UTF-8 bytes', async () => {
		const record = Object.fromEntries(
			Array.from({ length: 200 }, (_, index) => [`c${index}`, 'é'.repeat(5_000)]),
		);
		const bytes = new TextEncoder().encode(JSON.stringify([record, record]));
		const test = harness([
			{ ContentLength: bytes.length, ContentType: 'application/json' },
			{ Body: body(bytes) },
		]);
		const preview = await test.preview('wide.json');
		expect(preview).toMatchObject({ kind: 'tabular', truncated: true });
		if (preview.kind !== 'tabular') throw new Error('Expected tabular preview.');
		expect(preview.rows).toHaveLength(1);
		expect(new TextEncoder().encode(JSON.stringify(preview)).byteLength).toBeLessThanOrEqual(
			2 * 1024 * 1024,
		);
	});

	it('finds the bounded row prefix with logarithmic serializations', async () => {
		const record = Object.fromEntries(
			Array.from({ length: 200 }, (_, index) => [`c${index}`, 'x'.repeat(300)]),
		);
		const bytes = new TextEncoder().encode(
			JSON.stringify(Array.from({ length: 100 }, () => record)),
		);
		const encode = vi.spyOn(TextEncoder.prototype, 'encode');
		const test = harness([
			{ ContentLength: bytes.length, ContentType: 'application/json' },
			{ Body: body(bytes) },
		]);
		const preview = await test.preview('many-wide-rows.json', 100);
		expect(preview).toMatchObject({ kind: 'tabular', truncated: true });
		const previewSerializations = encode.mock.calls.filter(
			([value]) => typeof value === 'string' && value.startsWith('{"kind":"tabular"'),
		);
		expect(previewSerializations.length).toBeLessThanOrEqual(10);
		encode.mockRestore();
	});

	it('returns unsupported for an empty unknown object and an oversized image', async () => {
		const empty = harness([{ ContentLength: 0 }]);
		await expect(empty.preview('unknown.bin')).resolves.toMatchObject({
			kind: 'unsupported',
			total_bytes: 0,
		});
		expect(empty.sent()).toHaveLength(1);

		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const oversized = harness([{ ContentLength: 20 }, { Body: body(png) }], {
			inlineImageMaxBytes: 10,
			previewMaxBytes: png.length,
		});
		await expect(oversized.preview('large.bin')).resolves.toMatchObject({
			kind: 'unsupported',
			detected_type: 'png',
			total_bytes: 20,
		});
	});
});

describe('Parquet preview safety', () => {
	it('deduplicates ranges and enforces the aggregate range budget', async () => {
		parquet.metadata.mockImplementation(async (file: AsyncBuffer) => {
			await file.slice(0, 4);
			await file.slice(0, 4);
			await file.slice(4, 8);
			return { num_rows: 0n };
		});
		const bytes = new TextEncoder().encode('PAR1xxxx');
		const test = harness(
			[
				{ ContentLength: bytes.length, ETag: 'etag' },
				{ Body: body(bytes) },
				{ Body: body(bytes.slice(0, 4)) },
			],
			{ parquetMaxRangedBytes: 4 },
		);
		await expect(test.preview('data.parquet')).rejects.toMatchObject({
			code: 'unsupported',
			message: 'The Parquet preview exceeded its range budget.',
		});
		expect(test.sent()).toHaveLength(3);
		expect(test.destroyed()).toBe(1);
	});

	it.each([
		[-1, 1],
		[1, 1],
		[0, 9],
	])('rejects invalid reader ranges %s:%s', async (start, end) => {
		parquet.metadata.mockImplementation(async (file: AsyncBuffer) => file.slice(start, end));
		const bytes = new TextEncoder().encode('PAR1xxxx');
		const test = harness([{ ContentLength: bytes.length }, { Body: body(bytes) }]);
		await expect(test.preview('data.parquet')).rejects.toMatchObject({ code: 'unsupported' });
		expect(test.sent()).toHaveLength(2);
	});

	it('maps parser failures to a stable error without leaking parser details', async () => {
		parquet.metadata.mockRejectedValue(new Error('sensitive parser detail'));
		const bytes = new TextEncoder().encode('PAR1xxxx');
		const test = harness([{ ContentLength: bytes.length }, { Body: body(bytes) }]);
		let error: unknown;
		try {
			await test.preview('data.parquet');
		} catch (caught) {
			error = caught;
		}
		expect(error).toMatchObject({
			code: 'unsupported',
			message: 'The Parquet file could not be previewed.',
		});
		expect((error as Error).message).not.toContain('sensitive parser detail');
	});

	it('bounds columns, rows, nested values, and non-JSON scalar types', async () => {
		const columns = Array.from({ length: 201 }, (_, index) => ({ element: { name: `c${index}` } }));
		parquet.metadata.mockResolvedValue({ num_rows: 2n });
		parquet.schema.mockReturnValue({ children: columns });
		parquet.read.mockResolvedValue([
			{
				c0: Number.POSITIVE_INFINITY,
				c1: 42n,
				c2: new Date('2026-08-01T00:00:00Z'),
				c3: new Uint8Array([1]),
				c4: { child: { child: { child: { child: { child: { value: 1 } } } } } },
			},
		]);
		const bytes = new TextEncoder().encode('PAR1xxxx');
		const test = harness([{ ContentLength: bytes.length }, { Body: body(bytes) }]);
		const preview = await test.preview('data.parquet', 1);
		expect(preview).toMatchObject({
			kind: 'tabular',
			format: 'parquet',
			truncated: true,
			warnings: ['Some non-finite numbers were converted to strings.'],
		});
		if (preview.kind !== 'tabular') throw new Error('Expected tabular preview.');
		expect(preview.columns).toHaveLength(200);
		expect(preview.rows[0]?.slice(0, 4)).toEqual([
			'Infinity',
			'42',
			'2026-08-01T00:00:00.000Z',
			'[binary value]',
		]);
		expect(preview.rows[0]?.[4]).toContain('[nested value truncated]');
	});
});

function harness(
	responses: unknown[],
	limits: ConstructorParameters<typeof S3ObjectBrowser>[0]['limits'] = {},
) {
	const queue = [...responses];
	const sent: unknown[] = [];
	let destroyed = 0;
	const client: S3ClientLike = {
		async send(command) {
			sent.push(command);
			const response = queue.shift();
			if (response instanceof Error) throw response;
			return response;
		},
		destroy() {
			destroyed += 1;
		},
	};
	const browser = new S3ObjectBrowser({ mode: 'full', limits, clientFactory: () => client });
	return {
		preview(key: string, limit = 20) {
			return browser.previewObject(source, context, {
				bucket: 'lake',
				key,
				limit,
				content_url: '/content',
			});
		},
		sent: () => sent,
		destroyed: () => destroyed,
	};
}

function body(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}
