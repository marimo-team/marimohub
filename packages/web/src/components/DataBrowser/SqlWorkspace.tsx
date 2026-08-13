import {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from 'react';
import type { Ref } from 'react';
import { basicSetup } from 'codemirror';
import { autocompletion, closeBrackets } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, foldGutter, indentOnInput } from '@codemirror/language';
import { lintGutter } from '@codemirror/lint';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import type { EditorState } from '@codemirror/state';
import { Compartment, EditorSelection } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, keymap } from '@codemirror/view';
import { sql } from '@codemirror/lang-sql';
import {
	defaultSqlHoverTheme,
	NodeSqlParser,
	QueryContextAnalyzer,
	sqlCompletion,
	sqlExtension,
} from '@marimo-team/codemirror-sql';
import { DuckDBDialect } from '@marimo-team/codemirror-sql/dialects';
import { format as formatSql } from 'sql-formatter';
import {
	Bot,
	Clipboard,
	Download,
	Eraser,
	History as HistoryIcon,
	Play,
	Sparkles,
	Square,
	WandSparkles,
} from 'lucide-react';
import { Button, EmptyState, Skeleton } from '@/components/ui';
import {
	useDataQuerySchemaQuery,
	useGenerateDataQuerySql,
	useRunDataQuery,
	useUserQuery,
} from '@/api/hooks';
import { useTheme } from '@/context/ThemeContext';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { triggerDownload } from '@/lib/download';
import { errorMessage } from '@/lib/errors';
import { cn } from '@/lib/utils';

interface Selection {
	namespace: string[];
	table: string;
}

interface QueryTable {
	namespace: string[];
	name: string;
	columns: { name: string; type: string; nullable: boolean }[];
}

interface QueryResult {
	columns: string[];
	rows: unknown[][];
	truncated: boolean;
	execution_ms: number;
}

interface SqlEditorHandle {
	getSql(): string;
	getRunSql(): string;
	replaceSql(sql: string): void;
	format(): void;
	focus(): void;
}

const DEFAULT_SQL = '-- Select a table or write a DuckDB query\nSELECT 1 AS ready;';
const MAX_HISTORY = 20;

export default function SqlWorkspace({
	projectId,
	integrationId,
	integrationName,
	selection,
	aiAvailable,
}: {
	projectId: string;
	integrationId: string;
	integrationName: string;
	selection: Selection | null;
	aiAvailable: boolean;
}) {
	const { data: user } = useUserQuery();
	const schemaQuery = useDataQuerySchemaQuery(projectId, integrationId, selection);
	const query = useRunDataQuery(projectId, integrationId);
	const generate = useGenerateDataQuerySql(projectId, integrationId);
	const editorRef = useRef<SqlEditorHandle>(null);
	const abortRef = useRef<AbortController>(null);
	const storageKey = `marimohub:sql:${user?.id ?? 'unknown'}:${projectId}:${integrationId}`;
	const stored = useMemo(() => readStoredWorkspace(storageKey), [storageKey]);
	const [result, setResult] = useState<QueryResult | null>(null);
	const [submittedSql, setSubmittedSql] = useState('');
	const [historyItems, setHistoryItems] = useState<string[]>(stored.history);
	const [instruction, setInstruction] = useState('');
	const [showHistory, setShowHistory] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const { copy, copied } = useCopyToClipboard();

	const persistDraft = useCallback(
		(sqlText: string) =>
			writeStoredWorkspace(storageKey, { draft: sqlText, history: historyItems }),
		[historyItems, storageKey],
	);

	const run = useCallback(
		async (all = false) => {
			const sqlText = all ? editorRef.current?.getSql() : editorRef.current?.getRunSql();
			if (!sqlText?.trim()) return;
			abortRef.current?.abort();
			const controller = new AbortController();
			abortRef.current = controller;
			setError(null);
			setSubmittedSql(sqlText);
			try {
				const data = await query.mutateAsync({ sql: sqlText, signal: controller.signal });
				setResult(data as QueryResult);
				setHistoryItems((current) => {
					const next = [sqlText, ...current.filter((item) => item !== sqlText)].slice(
						0,
						MAX_HISTORY,
					);
					writeStoredWorkspace(storageKey, {
						draft: editorRef.current?.getSql() ?? sqlText,
						history: next,
					});
					return next;
				});
			} catch (cause) {
				if (!controller.signal.aborted) setError(errorMessage(cause));
			} finally {
				if (abortRef.current === controller) abortRef.current = null;
			}
		},
		[query, storageKey],
	);

	const generateSql = async () => {
		if (!instruction.trim()) return;
		setError(null);
		try {
			const current = editorRef.current?.getRunSql() ?? '';
			const data = await generate.mutateAsync({
				mode: current.trim() ? 'revise' : 'generate',
				instruction,
				...(current.trim() ? { sql: current } : {}),
			});
			editorRef.current?.replaceSql(data.sql);
			editorRef.current?.focus();
			setInstruction('');
		} catch (cause) {
			setError(errorMessage(cause));
		}
	};

	if (schemaQuery.isPending) return <Skeleton className="h-full min-h-96 w-full" />;
	if (schemaQuery.isError) {
		return (
			<EmptyState
				icon={<Bot />}
				message="SQL schema unavailable"
				description={errorMessage(schemaQuery.error)}
			/>
		);
	}

	const schema = schemaQuery.data;
	return (
		<div className="flex min-h-[34rem] flex-col overflow-hidden rounded-xl border bg-card">
			<div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
				<Button
					size="sm"
					variant="primary"
					onPress={() => void run(false)}
					isDisabled={query.isPending}
				>
					<Play className="size-3.5" /> Run
				</Button>
				<Button size="sm" onPress={() => void run(true)} isDisabled={query.isPending}>
					Run all
				</Button>
				{query.isPending ? (
					<Button size="sm" variant="danger" onPress={() => abortRef.current?.abort()}>
						<Square className="size-3.5" /> Cancel
					</Button>
				) : null}
				<Button size="sm" variant="ghost" onPress={() => editorRef.current?.format()}>
					<WandSparkles className="size-3.5" /> Format
				</Button>
				<Button
					size="sm"
					variant="ghost"
					onPress={() => void copy(editorRef.current?.getSql() ?? '')}
				>
					<Clipboard className="size-3.5" /> {copied ? 'Copied' : 'Copy SQL'}
				</Button>
				<Button size="sm" variant="ghost" onPress={() => setShowHistory((value) => !value)}>
					<HistoryIcon className="size-3.5" /> History
				</Button>
				<Button size="sm" variant="ghost" onPress={() => editorRef.current?.replaceSql('')}>
					<Eraser className="size-3.5" /> Clear
				</Button>
				<span className="ml-auto text-xs text-muted-foreground">
					⌘/Ctrl+Enter runs the selection or current statement
				</span>
			</div>
			{aiAvailable ? (
				<div className="flex gap-2 border-b bg-muted/20 p-3">
					<Sparkles className="mt-2 size-4 shrink-0 text-primary" />
					<textarea
						aria-label="AI SQL instruction"
						value={instruction}
						onChange={(event) => setInstruction(event.target.value)}
						onKeyDown={(event) => {
							if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
								event.preventDefault();
								void generateSql();
							}
						}}
						placeholder="Ask AI to generate a query, or revise the current selection…"
						className="min-h-9 flex-1 resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
					/>
					<Button
						size="sm"
						onPress={() => void generateSql()}
						isDisabled={generate.isPending || !instruction.trim()}
					>
						<Sparkles className="size-3.5" /> {generate.isPending ? 'Generating…' : 'Apply SQL'}
					</Button>
				</div>
			) : null}
			{showHistory && historyItems.length > 0 ? (
				<div className="max-h-36 overflow-y-auto border-b bg-muted/20 p-2">
					{historyItems.map((item) => (
						<button
							type="button"
							key={item}
							onClick={() => editorRef.current?.replaceSql(item)}
							className="block w-full truncate rounded px-2 py-1 text-left font-mono text-xs hover:bg-muted"
						>
							{item.replaceAll(/\s+/g, ' ')}
						</button>
					))}
				</div>
			) : null}
			<SqlEditor
				ref={editorRef}
				initialSql={stored.draft || DEFAULT_SQL}
				tables={schema.tables}
				integrationName={integrationName}
				onRun={() => void run(false)}
				onChange={persistDraft}
			/>
			{schema.truncated.tables || schema.truncated.columns || schema.truncated.bytes ? (
				<p className="border-t bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
					Completion schema is bounded; some tables or columns were omitted.
				</p>
			) : null}
			<div className="min-h-56 flex-1 overflow-auto border-t p-3">
				{error ? <p className="mb-3 text-sm text-destructive">{error}</p> : null}
				{query.isPending ? (
					<Skeleton className="h-32 w-full" />
				) : result ? (
					<QueryResults result={result} sql={submittedSql} />
				) : (
					<p className="text-sm text-muted-foreground">Run a query to see results.</p>
				)}
			</div>
		</div>
	);
}

const SqlEditor = forwardRef(function SqlEditor(
	{
		initialSql,
		tables,
		integrationName,
		onRun,
		onChange,
	}: {
		initialSql: string;
		tables: QueryTable[];
		integrationName: string;
		onRun: () => void;
		onChange: (sql: string) => void;
	},
	ref: Ref<SqlEditorHandle>,
) {
	const parentRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView>(null);
	const onRunRef = useRef(onRun);
	const onChangeRef = useRef(onChange);
	const schemaCompartment = useRef(new Compartment()).current;
	const themeCompartment = useRef(new Compartment()).current;
	const { theme } = useTheme();
	const schema = useMemo(
		() => completionSchema(tables, integrationName),
		[tables, integrationName],
	);
	const initialSchemaRef = useRef(schema);
	const initialThemeRef = useRef(theme);
	onRunRef.current = onRun;
	onChangeRef.current = onChange;

	useImperativeHandle(ref, () => ({
		getSql: () => viewRef.current?.state.doc.toString() ?? '',
		getRunSql: () => (viewRef.current ? selectedOrCurrentStatement(viewRef.current.state) : ''),
		replaceSql: (next) => {
			const view = viewRef.current;
			if (!view) return;
			view.dispatch({
				changes: { from: 0, to: view.state.doc.length, insert: next },
				selection: EditorSelection.cursor(next.length),
			});
		},
		format: () => {
			const view = viewRef.current;
			if (!view) return;
			try {
				const formatted = formatSql(view.state.doc.toString(), {
					language: 'duckdb',
					keywordCase: 'upper',
				});
				view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: formatted } });
			} catch {}
		},
		focus: () => viewRef.current?.focus(),
	}));

	useEffect(() => {
		if (!parentRef.current) return;
		const parser = new NodeSqlParser({
			getParserOptions: () => ({ database: 'DuckDB' }),
		});
		const contextAnalyzer = new QueryContextAnalyzer(parser);
		const view = new EditorView({
			parent: parentRef.current,
			doc: initialSql,
			extensions: [
				basicSetup,
				history(),
				foldGutter(),
				lintGutter(),
				drawSelection(),
				indentOnInput(),
				bracketMatching(),
				closeBrackets(),
				autocompletion({ activateOnTyping: true }),
				highlightActiveLine(),
				highlightSelectionMatches(),
				keymap.of([
					{
						key: 'Mod-Enter',
						run: () => {
							onRunRef.current();
							return true;
						},
					},
					indentWithTab,
					...defaultKeymap,
					...historyKeymap,
					...searchKeymap,
				]),
				EditorView.updateListener.of((update) => {
					if (update.docChanged) onChangeRef.current(update.state.doc.toString());
				}),
				schemaCompartment.of(schemaExtensions(initialSchemaRef.current, parser, contextAnalyzer)),
				themeCompartment.of(editorTheme(initialThemeRef.current)),
			],
		});
		viewRef.current = view;
		return () => {
			view.destroy();
			viewRef.current = null;
		};
	}, [initialSql, schemaCompartment, themeCompartment]);

	useEffect(() => {
		viewRef.current?.dispatch({
			effects: schemaCompartment.reconfigure(schemaExtensions(schema, undefined, undefined)),
		});
	}, [schema, schemaCompartment]);

	useEffect(() => {
		viewRef.current?.dispatch({ effects: themeCompartment.reconfigure(editorTheme(theme)) });
	}, [theme, themeCompartment]);

	return <div ref={parentRef} className="min-h-56 overflow-auto font-mono text-sm" />;
});

function schemaExtensions(
	schema: Record<string, string[]>,
	parser = new NodeSqlParser({ getParserOptions: () => ({ database: 'DuckDB' }) }),
	contextAnalyzer = new QueryContextAnalyzer(parser),
) {
	return [
		sql({ dialect: DuckDBDialect, schema, upperCaseKeywords: true }),
		...sqlCompletion({ dialect: DuckDBDialect, schema, parser, contextAnalyzer }),
		...sqlExtension({
			schema,
			linterConfig: { delay: 250, parser },
			semanticLinterConfig: {
				severity: { unknownTable: 'warning', unknownColumn: 'warning', ambiguousColumn: 'warning' },
			},
			gutterConfig: { hideWhenNotFocused: true },
			enableHover: true,
			hoverConfig: {
				hoverTime: 250,
				enableKeywords: true,
				enableTables: true,
				enableColumns: true,
			},
			enableNavigation: true,
			navigationConfig: { keymap: true },
		}),
		defaultSqlHoverTheme(),
	];
}

function editorTheme(theme: 'light' | 'dark') {
	return EditorView.theme(
		{
			'&': { backgroundColor: 'hsl(var(--card))', color: 'hsl(var(--foreground))' },
			'.cm-content': { minHeight: '14rem', padding: '0.75rem' },
			'.cm-gutters': { backgroundColor: 'hsl(var(--muted) / 0.35)', border: 'none' },
			'.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'hsl(var(--muted) / 0.45)' },
			'.cm-tooltip': {
				backgroundColor: 'hsl(var(--popover))',
				color: 'hsl(var(--popover-foreground))',
				borderColor: 'hsl(var(--border))',
			},
		},
		{ dark: theme === 'dark' },
	);
}

function completionSchema(tables: QueryTable[], integrationName: string): Record<string, string[]> {
	const schema: Record<string, string[]> = {};
	for (const table of tables) {
		const columns = table.columns.map((column) => column.name);
		schema[table.name] = columns;
		schema[[...table.namespace, table.name].join('.')] = columns;
		schema[[integrationName, ...table.namespace, table.name].join('.')] = columns;
	}
	return schema;
}

export function selectedOrCurrentStatement(state: EditorState): string {
	const selection = state.sliceDoc(state.selection.main.from, state.selection.main.to);
	if (selection.trim()) return selection;
	const sqlText = state.doc.toString();
	const cursor = state.selection.main.head;
	const { from, to } = sqlStatementRangeAtCursor(sqlText, cursor);
	const statement = sqlText.slice(from, to).trim();
	return statement || sqlText.trim();
}

function sqlStatementRangeAtCursor(sql: string, cursor: number): { from: number; to: number } {
	let start = 0;
	let previous = { from: 0, to: sql.length };
	let mode: 'normal' | 'single' | 'double' | 'backtick' | 'line-comment' | 'block-comment' =
		'normal';
	let blockDepth = 0;
	let dollarDelimiter: string | undefined;
	for (let index = 0; index < sql.length; index++) {
		const character = sql[index];
		const next = sql[index + 1];
		if (dollarDelimiter !== undefined) {
			if (sql.startsWith(dollarDelimiter, index)) {
				index += dollarDelimiter.length - 1;
				dollarDelimiter = undefined;
			}
			continue;
		}
		if (mode === 'line-comment') {
			if (character === '\n' || character === '\r') mode = 'normal';
			continue;
		}
		if (mode === 'block-comment') {
			if (character === '/' && next === '*') {
				blockDepth++;
				index++;
			} else if (character === '*' && next === '/') {
				blockDepth--;
				index++;
				if (blockDepth === 0) mode = 'normal';
			}
			continue;
		}
		if (mode !== 'normal') {
			const quote = mode === 'single' ? "'" : mode === 'double' ? '"' : '`';
			if (character === quote) {
				if (next === quote) index++;
				else mode = 'normal';
			}
			continue;
		}
		if (character === '-' && next === '-') {
			mode = 'line-comment';
			index++;
			continue;
		}
		if (character === '/' && next === '*') {
			mode = 'block-comment';
			blockDepth = 1;
			index++;
			continue;
		}
		if (character === "'" || character === '"' || character === '`') {
			mode = character === "'" ? 'single' : character === '"' ? 'double' : 'backtick';
			continue;
		}
		if (character === '$') {
			const delimiter = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index))?.[0];
			if (delimiter !== undefined) {
				dollarDelimiter = delimiter;
				index += delimiter.length - 1;
				continue;
			}
		}
		if (character !== ';') continue;
		const range = { from: start, to: index + 1 };
		if (cursor <= index) return range;
		previous = range;
		start = index + 1;
	}
	if (start < sql.length) return { from: start, to: sql.length };
	return previous;
}

function QueryResults({ result, sql: _sql }: { result: QueryResult; sql: string }) {
	const [sort, setSort] = useState<{ index: number; direction: 1 | -1 } | null>(null);
	const headers = useMemo(() => keyedValues(result.columns), [result.columns]);
	const rows = useMemo(() => {
		if (!sort) return result.rows;
		return result.rows.toSorted(
			(left, right) =>
				renderCell(left[sort.index]).localeCompare(renderCell(right[sort.index]), undefined, {
					numeric: true,
				}) * sort.direction,
		);
	}, [result.rows, sort]);
	const csv = () =>
		[result.columns, ...result.rows].map((row) => row.map(csvCell).join(',')).join('\n');
	return (
		<div>
			<div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
				<span>{result.rows.length.toLocaleString()} rows</span>
				<span>{result.execution_ms.toLocaleString()} ms</span>
				{result.truncated ? (
					<span className="font-medium text-amber-600">Result truncated</span>
				) : null}
				<Button
					size="sm"
					variant="ghost"
					className="ml-auto"
					onPress={() =>
						triggerDownload('query-results.csv', new Blob([csv()], { type: 'text/csv' }))
					}
				>
					<Download className="size-3.5" /> CSV
				</Button>
			</div>
			<div className="max-h-[32rem] overflow-auto rounded-md border">
				<table className="w-full whitespace-nowrap text-left text-xs">
					<thead className="sticky top-0 z-10 bg-muted">
						<tr>
							<th className="w-12 px-2 py-2 text-right font-medium text-muted-foreground">#</th>
							{headers.map(({ key, value: column }, index) => (
								<th key={key} className="resize-x overflow-auto px-3 py-2 font-medium">
									<button
										type="button"
										onClick={() =>
											setSort((current) => ({
												index,
												direction: current?.index === index && current.direction === 1 ? -1 : 1,
											}))
										}
										className="w-full text-left"
									>
										{column}
										{sort?.index === index ? (sort.direction === 1 ? ' ↑' : ' ↓') : ''}
									</button>
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{keyedRows(rows).map(({ key, row, rowIndex }) => (
							<tr key={key} className="border-t hover:bg-muted/30">
								<td className="px-2 py-1.5 text-right text-muted-foreground">{rowIndex + 1}</td>
								{headers.map(({ key: columnKey }, columnIndex) => {
									const rendered = renderCell(row[columnIndex]);
									return (
										<td
											key={columnKey}
											title="Click to copy"
											onClick={() => void navigator.clipboard.writeText(rendered)}
											className={cn(
												'max-w-96 cursor-copy truncate px-3 py-1.5 font-mono',
												rendered === 'null' && 'italic text-muted-foreground',
											)}
										>
											{rendered}
										</td>
									);
								})}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}

function renderCell(value: unknown): string {
	if (value === null) return 'null';
	if (value === undefined) return '';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	try {
		return JSON.stringify(value) ?? '';
	} catch {
		return '[unserializable]';
	}
}

function csvCell(value: unknown): string {
	const text = renderCell(value);
	return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function keyedValues(values: string[]): { key: string; value: string }[] {
	const counts = new Map<string, number>();
	return values.map((value) => {
		const occurrence = counts.get(value) ?? 0;
		counts.set(value, occurrence + 1);
		return { key: `${value}:${occurrence}`, value };
	});
}

function keyedRows(rows: unknown[][]): { key: string; row: unknown[]; rowIndex: number }[] {
	const counts = new Map<string, number>();
	return rows.map((row, rowIndex) => {
		const base = JSON.stringify(row.map(renderCell));
		const occurrence = counts.get(base) ?? 0;
		counts.set(base, occurrence + 1);
		return { key: `${base}:${occurrence}`, row, rowIndex };
	});
}

function readStoredWorkspace(key: string): { draft: string; history: string[] } {
	try {
		const parsed = JSON.parse(localStorage.getItem(key) ?? '{}') as {
			draft?: unknown;
			history?: unknown;
		};
		return {
			draft: typeof parsed.draft === 'string' ? parsed.draft : '',
			history: Array.isArray(parsed.history)
				? parsed.history
						.filter((item): item is string => typeof item === 'string')
						.slice(0, MAX_HISTORY)
				: [],
		};
	} catch {
		return { draft: '', history: [] };
	}
}

function writeStoredWorkspace(key: string, value: { draft: string; history: string[] }): void {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {}
}
