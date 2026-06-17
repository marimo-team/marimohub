// A declarative finite state machine: a transition table plus no-op
// self-transitions and sticky terminal states. Keeps a machine's rules in data so
// a domain module (e.g. session lifecycle) is a config, not bespoke branching.

export interface StateMachine<S extends string, E extends string> {
	/** State after `event`, or `null` for a no-op/illegal edge (incl. any event on a
	 * terminal state, or one that wouldn't change the state) — so callers skip the write. */
	next(state: S, event: E): S | null;
	/** Whether `state` is terminal (no outgoing transitions). */
	isTerminal(state: S): boolean;
}

export interface StateMachineConfig<S extends string, E extends string> {
	/** Allowed edges: `transitions[from][event] = to`. Omit an edge to forbid it. */
	transitions: Record<S, Partial<Record<E, S>>>;
	/** States with no outgoing transitions; `isTerminal` reports these. */
	terminal?: readonly S[];
}

export function createStateMachine<S extends string, E extends string>(
	config: StateMachineConfig<S, E>,
): StateMachine<S, E> {
	const terminal = new Set<S>(config.terminal ?? []);
	return {
		next(state, event) {
			const to = config.transitions[state]?.[event];
			return to === undefined || to === state ? null : to;
		},
		isTerminal: (state) => terminal.has(state),
	};
}
