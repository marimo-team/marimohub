export function TabularPreviewGrid({
	columns,
	rows,
	emptyMessage = 'This preview returned no rows.',
	truncated = false,
}: {
	columns: readonly (string | { name: string })[];
	rows: unknown[][];
	emptyMessage?: string;
	truncated?: boolean;
}) {
	if (rows.length === 0) {
		return <p className="text-xs text-muted-foreground">{emptyMessage}</p>;
	}
	const names = columns.map((column) => (typeof column === 'string' ? column : column.name));
	const headers = keyedNames(names);
	return (
		<div>
			<div className="overflow-x-auto rounded-md border border-input">
				<table className="w-full whitespace-nowrap text-left text-xs tabular-nums">
					<thead className="bg-muted/40">
						<tr>
							{headers.map(({ key, name }) => (
								<th key={key} className="px-3 py-2 font-medium">
									{name}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{keyedRows(rows).map(({ key, cells }) => (
							<tr key={key} className="border-t border-input/50">
								{headers.map(({ key: columnKey }, index) => {
									const value = cells[index] ?? '';
									return (
										<td
											key={columnKey}
											className="max-w-80 truncate px-3 py-2 font-mono"
											title={value}
										>
											{value}
										</td>
									);
								})}
							</tr>
						))}
					</tbody>
				</table>
			</div>
			{truncated && <p className="mt-2 text-xs text-muted-foreground">Preview truncated.</p>}
		</div>
	);
}

function keyedNames(names: string[]): { key: string; name: string }[] {
	const counts = new Map<string, number>();
	return names.map((name) => {
		const occurrence = counts.get(name) ?? 0;
		counts.set(name, occurrence + 1);
		return { key: `${name}:${occurrence}`, name };
	});
}

function keyedRows(rows: unknown[][]): { key: string; cells: string[] }[] {
	const counts = new Map<string, number>();
	return rows.map((row) => {
		const cells = Array.from(row, renderCell);
		const base = JSON.stringify(cells);
		const occurrence = counts.get(base) ?? 0;
		counts.set(base, occurrence + 1);
		return { key: `${base}:${occurrence}`, cells };
	});
}

function renderCell(value: unknown): string {
	if (value === null) return 'null';
	if (value === undefined) return '';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
		return String(value);
	}
	try {
		return JSON.stringify(value) ?? '';
	} catch {
		return '[unserializable]';
	}
}
