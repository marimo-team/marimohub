import { createTraceState, ROOT_CONTEXT, SpanKind, trace, TraceFlags } from '@opentelemetry/api';
import { SamplingDecision } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';
import { LoopSampler } from './loopSampler';

const traceId = '0123456789abcdef0123456789abcdef';
const sample = (sampler: LoopSampler, name: string, context = ROOT_CONTEXT) =>
	sampler.shouldSample(context, traceId, name, SpanKind.INTERNAL, {}, []);

describe('LoopSampler', () => {
	it('does not let an incoming loop marker override the global sampler', () => {
		const sampler = new LoopSampler({ OTEL_TRACES_SAMPLER: 'always_off' });
		const remote = trace.setSpanContext(ROOT_CONTEXT, {
			traceId,
			spanId: '0123456789abcdef',
			traceFlags: TraceFlags.SAMPLED,
			isRemote: true,
			traceState: createTraceState('mh-loop=1'),
		});
		expect(sample(sampler, 'GET /api/v1/projects', remote).decision).toBe(
			SamplingDecision.NOT_RECORD,
		);
	});
	it('drops loop trees at creation without dropping foreground requests', () => {
		const sampler = new LoopSampler({
			OTEL_TRACES_LOOP_SAMPLE_RATIO: '0',
			OTEL_TRACES_SAMPLER: 'always_on',
		});
		const root = sample(sampler, 'loop.maintenance');
		expect(root.decision).toBe(SamplingDecision.NOT_RECORD);
		const parent = trace.setSpanContext(ROOT_CONTEXT, {
			traceId,
			spanId: '0123456789abcdef',
			traceFlags: TraceFlags.NONE,
			traceState: root.traceState,
		});
		expect(sample(sampler, 'Bucket.get', parent).decision).toBe(SamplingDecision.NOT_RECORD);
		expect(sample(sampler, 'GET /api/v1/projects').decision).toBe(
			SamplingDecision.RECORD_AND_SAMPLED,
		);
	});
	it('honors the global always-off sampler even when all loops are enabled', () => {
		const sampler = new LoopSampler({
			OTEL_TRACES_LOOP_SAMPLE_RATIO: '1',
			OTEL_TRACES_SAMPLER: 'always_off',
		});
		expect(sample(sampler, 'loop.jobs').decision).toBe(SamplingDecision.NOT_RECORD);
	});
	it.each(['traceidratio', 'parentbased_traceidratio', 'parentbased_always_off'])(
		'never enables loop roots disabled by %s',
		(OTEL_TRACES_SAMPLER) => {
			const sampler = new LoopSampler({
				OTEL_TRACES_SAMPLER,
				OTEL_TRACES_SAMPLER_ARG: '0',
				OTEL_TRACES_LOOP_SAMPLE_RATIO: '1',
			});
			expect(sample(sampler, 'loop.jobs').decision).toBe(SamplingDecision.NOT_RECORD);
		},
	);

	it('keeps the foreground parent decision for a loop-named child', () => {
		const sampler = new LoopSampler({ OTEL_TRACES_LOOP_SAMPLE_RATIO: '0' });
		const parent = trace.setSpanContext(ROOT_CONTEXT, {
			traceId,
			spanId: '0123456789abcdef',
			traceFlags: TraceFlags.SAMPLED,
			traceState: createTraceState('vendor=value'),
		});
		const child = sample(sampler, 'loop.manual-maintenance', parent);
		expect(child.decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
		expect(child.traceState?.get('mh-loop')).toBeUndefined();
	});
	it('retains sampled loop descendants and preserves valid configuration', () => {
		const sampler = new LoopSampler({ OTEL_TRACES_LOOP_SAMPLE_RATIO: '1' });
		const root = sample(sampler, 'loop.jobs');
		expect(root.decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
		const parent = trace.setSpanContext(ROOT_CONTEXT, {
			traceId,
			spanId: '0123456789abcdef',
			traceFlags: TraceFlags.SAMPLED,
			traceState: root.traceState,
		});
		expect(sample(sampler, 'JobScheduler.tick', parent).decision).toBe(
			SamplingDecision.RECORD_AND_SAMPLED,
		);
	});
});

it.each(['', ' ', '\t', 'bad', '-1', '2'])(
	'uses ratio defaults for invalid configuration %j',
	(value) => {
		const sampler = new LoopSampler({
			OTEL_TRACES_SAMPLER: 'traceidratio',
			OTEL_TRACES_SAMPLER_ARG: value,
			OTEL_TRACES_LOOP_SAMPLE_RATIO: value,
		});
		expect(sample(sampler, 'request').decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
		expect(sampler.toString()).toContain('TraceIdRatioBased{0.01}');
	},
);
it.each(['', 'prefix_always_off', 'parentbased_typo', 'prefix_traceidratio'])(
	'uses the parent-based default for unknown sampler %j',
	(name) => {
		const sampler = new LoopSampler({ OTEL_TRACES_SAMPLER: name, OTEL_TRACES_SAMPLER_ARG: '0' });
		expect(sample(sampler, 'request').decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
		const parent = trace.setSpanContext(ROOT_CONTEXT, {
			traceId,
			spanId: '0123456789abcdef',
			traceFlags: TraceFlags.NONE,
		});
		expect(sample(sampler, 'request', parent).decision).toBe(SamplingDecision.NOT_RECORD);
	},
);
