import { createTraceState, trace, TraceFlags } from '@opentelemetry/api';
import type { Attributes, Context, Link, SpanKind } from '@opentelemetry/api';
import {
	AlwaysOffSampler,
	AlwaysOnSampler,
	ParentBasedSampler,
	TraceIdRatioBasedSampler,
	SamplingDecision,
} from '@opentelemetry/sdk-trace-base';
import type { Sampler, SamplingResult } from '@opentelemetry/sdk-trace-base';

function ratio(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

export class LoopSampler implements Sampler {
	private readonly loops: Sampler;
	private readonly foreground: Sampler;

	constructor(env: Record<string, string | undefined> = process.env) {
		const name = env.OTEL_TRACES_SAMPLER ?? 'parentbased_always_on';
		const root = name.endsWith('always_off')
			? new AlwaysOffSampler()
			: name.endsWith('traceidratio')
				? new TraceIdRatioBasedSampler(ratio(env.OTEL_TRACES_SAMPLER_ARG, 1))
				: new AlwaysOnSampler();
		this.foreground = name.startsWith('parentbased_') ? new ParentBasedSampler({ root }) : root;
		this.loops = new TraceIdRatioBasedSampler(ratio(env.OTEL_TRACES_LOOP_SAMPLE_RATIO, 0.01));
	}

	shouldSample(
		context: Context,
		traceId: string,
		name: string,
		kind: SpanKind,
		attributes: Attributes,
		links: Link[],
	): SamplingResult {
		const parent = trace.getSpanContext(context);
		const foreground = this.foreground.shouldSample(
			context,
			traceId,
			name,
			kind,
			attributes,
			links,
		);
		if (parent?.traceState?.get('mh-loop') === '1')
			return {
				decision:
					foreground.decision !== SamplingDecision.NOT_RECORD &&
					(parent.traceFlags & TraceFlags.SAMPLED) !== 0
						? SamplingDecision.RECORD_AND_SAMPLED
						: SamplingDecision.NOT_RECORD,
				traceState: parent.traceState,
			};
		if (!name.startsWith('loop.') || parent) return foreground;
		const loop = this.loops.shouldSample(context, traceId, name, kind, attributes, links);
		return {
			decision:
				foreground.decision === SamplingDecision.NOT_RECORD ? foreground.decision : loop.decision,
			traceState: (foreground.traceState ?? createTraceState()).set('mh-loop', '1'),
		};
	}

	toString(): string {
		return `LoopSampler(${this.loops.toString()}, ${this.foreground.toString()})`;
	}
}
