/* oxlint-disable react/no-array-index-key -- Query results can contain duplicate rows and column names and have no stable IDs. */
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
	const visibleColumns = columns.slice(0, 50);
	const visibleRows = rows.slice(0, 100);
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
						{visibleColumns.map((name, index) => (
							<th
								key={index}
								scope="col"
								className="sticky top-0 border-b bg-muted px-3 py-2 font-medium"
							>
								{name}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{visibleRows.map((row, index) => (
						<tr key={index}>
							{visibleColumns.map((_, column) => (
								<td key={column} className="max-w-80 truncate border-b px-3 py-1.5">
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
