import { describe, expect, it } from 'vitest';
import { createStateMachine } from './fsm';

type S = 'idle' | 'on' | 'broken';
type E = 'flip' | 'break';

const machine = createStateMachine<S, E>({
	transitions: {
		idle: { flip: 'on', break: 'broken' },
		on: { flip: 'idle', break: 'broken' },
		broken: {},
	},
	terminal: ['broken'],
});

describe('createStateMachine', () => {
	it('follows declared edges', () => {
		expect(machine.next('idle', 'flip')).toBe('on');
		expect(machine.next('on', 'flip')).toBe('idle');
		expect(machine.next('idle', 'break')).toBe('broken');
	});

	it('returns null for an undeclared edge', () => {
		const m = createStateMachine<S, E>({ transitions: { idle: {}, on: {}, broken: {} } });
		expect(m.next('idle', 'flip')).toBeNull();
	});

	it('returns null for a self-transition (no change → skippable write)', () => {
		const m = createStateMachine<S, E>({
			transitions: { idle: { flip: 'idle' }, on: {}, broken: {} },
		});
		expect(m.next('idle', 'flip')).toBeNull();
	});

	it('keeps terminal states sticky', () => {
		expect(machine.isTerminal('broken')).toBe(true);
		expect(machine.isTerminal('idle')).toBe(false);
		expect(machine.next('broken', 'flip')).toBeNull();
		expect(machine.next('broken', 'break')).toBeNull();
	});
});
