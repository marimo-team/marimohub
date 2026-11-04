import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lastConversation } from './lastConversation';

const blocked = (method: 'getItem' | 'setItem' | 'removeItem') =>
	vi.spyOn(Storage.prototype, method).mockImplementation(() => {
		throw new DOMException('blocked', 'SecurityError');
	});

describe('lastConversation', () => {
	beforeEach(() => sessionStorage.clear());
	afterEach(() => vi.restoreAllMocks());

	it('keeps one remembered conversation per project', () => {
		lastConversation.remember('sales', 'conversation-1');
		lastConversation.remember('finance', 'conversation-2');
		expect(lastConversation.recall('sales')).toBe('conversation-1');
		expect(lastConversation.recall('finance')).toBe('conversation-2');
		expect(lastConversation.recall('ops')).toBeNull();
	});

	it('forgets a project when remembering null', () => {
		lastConversation.remember('sales', 'conversation-1');
		lastConversation.remember('sales', null);
		expect(lastConversation.recall('sales')).toBeNull();
	});

	it('recalls nothing when storage reads throw', () => {
		blocked('getItem');
		expect(lastConversation.recall('sales')).toBeNull();
	});

	it('swallows storage write failures', () => {
		blocked('setItem');
		blocked('removeItem');
		expect(() => lastConversation.remember('sales', 'conversation-1')).not.toThrow();
		expect(() => lastConversation.remember('sales', null)).not.toThrow();
	});
});
