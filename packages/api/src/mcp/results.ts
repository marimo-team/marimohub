export type ToolResult = {
	content: { type: 'text'; text: string }[];
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
};

export function result(
	data: Record<string, unknown>,
	text = JSON.stringify(data, null, 2),
): ToolResult {
	return { content: [{ type: 'text', text }], structuredContent: data };
}

export function failureResult(data: Record<string, unknown>): ToolResult {
	return { ...result(data), isError: true };
}
