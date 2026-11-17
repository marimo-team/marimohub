import { z } from 'zod';

const TableResult = z.object({
	columns: z.array(z.string()).max(1000),
	rows: z.array(z.array(z.unknown())).max(1000),
	truncated: z.boolean().optional(),
});

export function ToolTable({ output }: { output?: string }) {
	if (!output) return null;
	let value: unknown;
	try {
		value = JSON.parse(output);
	} catch {
		return null;
	}
	const parsed = TableResult.safeParse(value);
	if (!parsed.success || parsed.data.columns.length === 0) return null;
	const { columns, rows, truncated } = parsed.data;
	const visibleColumns = keyedItems(columns.slice(0, 50), (name) => name);
	const visibleRows = keyedItems(rows.slice(0, 100), (row) => JSON.stringify(row));
	const limited =
		truncated || columns.length > visibleColumns.length || rows.length > visibleRows.length;
	return (
		<section
			className="mt-2 max-h-80 overflow-auto rounded-md border"
			// oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard users must be able to scroll wide results.
			tabIndex={0}
			aria-label="Table results"
		>
			<table className="w-full border-collapse text-left text-xs">
				<caption className="p-2 text-left text-muted-foreground">
					{visibleRows.length} rows{limited ? ' · Partial results' : ''}
				</caption>
				<thead>
					<tr>
						{visibleColumns.map(({ key, value: name }) => (
							<th
								key={key}
								scope="col"
								className="sticky top-0 border-b bg-muted px-3 py-2 font-medium"
							>
								{name}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{visibleRows.map(({ key, value: row }) => (
						<tr key={key}>
							{visibleColumns.map(({ key: columnKey }, column) => (
								<td key={columnKey} className="max-w-80 truncate border-b px-3 py-1.5">
									{cellText(row[column])}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</section>
	);
}

function cellText(value: unknown): string {
	if (value === null || value === undefined) return 'null';
	const text = typeof value === 'string' ? value : JSON.stringify(value);
	return text.length > 1000 ? `${text.slice(0, 1000)}…` : text;
}

function keyedItems<T>(items: T[], identity: (item: T) => string) {
	const occurrences = new Map<string, number>();
	return items.map((value) => {
		const id = identity(value);
		// Equal query rows and repeated column names have no upstream IDs.
		const occurrence = occurrences.get(id) ?? 0;
		occurrences.set(id, occurrence + 1);
		return { key: JSON.stringify([id, occurrence]), value };
	});
}
