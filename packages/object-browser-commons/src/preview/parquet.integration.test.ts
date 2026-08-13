import { describe, expect, it } from 'vitest';
import { createProjectId, UserId } from '@marimo-hub/core';
import type { ObjectBrowseContext } from '@marimo-hub/core';
import { OBJECT_BROWSE_PARQUET_FIXTURE } from '@marimo-hub/core/testing/object-browse-contract';
import { DEFAULT_OBJECT_BROWSER_LIMITS } from '../limits';
import { previewObject } from './index';

const context: ObjectBrowseContext = {
	project_id: createProjectId(),
	user_id: UserId.parse('parquet-reader'),
	user_email: 'parquet-reader@example.com',
	allow_server_ambient: {},
};

describe('Parquet preview integration', () => {
	it('reads rows and schema from real Parquet bytes', async () => {
		const ranges: string[] = [];
		const preview = await previewObject(
			{
				head: async () => ({
					total_bytes: OBJECT_BROWSE_PARQUET_FIXTURE.byteLength,
					content_type: 'application/vnd.apache.parquet',
					etag: 'fixture-etag',
				}),
				readRange: async (_request, start, end, options) => {
					expect(options.etag).toBe('fixture-etag');
					ranges.push(`${start}:${end}`);
					return OBJECT_BROWSE_PARQUET_FIXTURE.subarray(start, end);
				},
			},
			{ ...DEFAULT_OBJECT_BROWSER_LIMITS, previewMaxBytes: 4 },
			context,
			{
				bucket: 'lake',
				key: 'people.parquet',
				limit: 20,
				content_url: '/content',
			},
		);

		expect(preview).toMatchObject({
			kind: 'tabular',
			format: 'parquet',
			columns: [{ name: 'id' }, { name: 'name' }],
			rows: [
				[1, 'Ada'],
				[2, 'Lin'],
			],
			truncated: false,
			total_bytes: OBJECT_BROWSE_PARQUET_FIXTURE.byteLength,
			warnings: [],
		});
		const [probe, ...parquetRanges] = ranges;
		expect(probe).toBe('0:4');
		expect(parquetRanges.length).toBeGreaterThan(1);
		expect(new Set(parquetRanges).size).toBe(parquetRanges.length);
		if (preview.kind !== 'tabular') throw new Error('Expected a tabular Parquet preview.');
		expect(preview.bytes_read).toBe(
			parquetRanges.reduce((total, range) => {
				const [start, end] = range.split(':').map(Number);
				return total + end - start;
			}, 0),
		);
	});

	it('enforces the range-byte budget with the real parser', async () => {
		await expect(
			previewObject(
				{
					head: async () => ({
						total_bytes: OBJECT_BROWSE_PARQUET_FIXTURE.byteLength,
						content_type: 'application/vnd.apache.parquet',
					}),
					readRange: async (_request, start, end) =>
						OBJECT_BROWSE_PARQUET_FIXTURE.subarray(start, end),
				},
				{
					...DEFAULT_OBJECT_BROWSER_LIMITS,
					previewMaxBytes: 4,
					parquetMaxRangedBytes: 1,
				},
				context,
				{
					bucket: 'lake',
					key: 'people.parquet',
					limit: 20,
					content_url: '/content',
				},
			),
		).rejects.toMatchObject({
			code: 'unsupported',
			message: 'The Parquet preview exceeded its range budget.',
		});
	});
});
