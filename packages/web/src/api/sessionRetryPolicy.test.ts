import { expect, it } from 'vitest';
import { ApiRequestError } from '@marimo-hub/client';
import { MAX_TIMER_DELAY_MS } from '@marimo-hub/core/async';
import { admissionRetryDelay, heartbeatRetryDelay } from './sessionRetryPolicy';

const unavailable = (retryAfterMs?: number) =>
	new ApiRequestError('SERVICE_UNAVAILABLE', 'Busy', { status: 503, retryAfterMs });

it.each([
	[0, 500],
	[1, 1000],
	[2, null],
	[3, null],
])('bounds admission retry attempt %i', (attempt, expected) => {
	expect(admissionRetryDelay(unavailable(), attempt)).toBe(expected);
});

it.each([
	[0, 0],
	[1.5, 2],
	[30_000, 30_000],
	[30_001, null],
])('honors admission Retry-After %i without an early retry', (delay, expected) => {
	expect(admissionRetryDelay(unavailable(delay), 0)).toBe(expected);
});

it.each([
	[new ApiRequestError('SERVICE_UNAVAILABLE', 'Busy', { status: 429 }), 500],
	[new ApiRequestError('RESOURCE_EXHAUSTED', 'Full', { status: 429 }), null],
	[new ApiRequestError('RESOURCE_EXHAUSTED', 'Full', { status: 503 }), null],
	[new ApiRequestError('SURFACE_UNAVAILABLE', 'Unavailable', { status: 503 }), null],
	[new ApiRequestError('CONFLICT', 'Conflict', { status: 409 }), null],
	[new ApiRequestError('NETWORK_ERROR', 'Disconnected'), null],
	[new Error('Disconnected'), null],
])('classifies admission error %s', (error, expected) => {
	expect(admissionRetryDelay(error, 0)).toBe(expected);
});

it.each([
	[0, 0, 8000],
	[1, 0, 500],
	[1, 1, 1000],
	[2, 0, 1000],
	[2, 1, 2000],
	[3, 0, 2000],
	[3, 1, 4000],
	[4, 0, 30_000],
	[100, 1, 30_000],
])('schedules heartbeat failure %i with jitter %i', (failures, jitter, expected) => {
	expect(heartbeatRetryDelay(failures, 8000, 0, jitter)).toBe(expected);
});

it('retains the normal editor interval after its bounded retry burst', () => {
	expect(heartbeatRetryDelay(4, 120_000, 0, 0)).toBe(120_000);
});

it('treats Retry-After as a minimum for heartbeats', () => {
	expect(heartbeatRetryDelay(1, 8000, 50_000, 0)).toBe(50_000);
	expect(heartbeatRetryDelay(1, 8000, 1, 0)).toBe(500);
});

it('bounds heartbeat timers and rounds their jittered delay', () => {
	expect(heartbeatRetryDelay(0, 8000, Number.MAX_SAFE_INTEGER, 0)).toBe(MAX_TIMER_DELAY_MS);
	expect(heartbeatRetryDelay(1, 8000, 0, 0.333)).toBe(666);
});
