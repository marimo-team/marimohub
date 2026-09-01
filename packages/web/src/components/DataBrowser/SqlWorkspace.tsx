import {
	forwardRef,
	useCallback,
	useEffect,
	useId,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react';
import type { Ref } from 'react';
import type { EditorView } from '@codemirror/view';
import type { Compartment } from '@codemirror/state';
import type { NodeSqlParser, QueryContextAnalyzer } from '@marimo-team/codemirror-sql';
import { format as formatSql } from 'sql-formatter';
import {
	Bot,
	Clipboard,
	Download,
	Eraser,
	History as HistoryIcon,
	Info,
	Maximize2,
	Minimize2,
	Play,
	Sparkles,
	Square,
	WandSparkles,
} from 'lucide-react';
import { Button, EmptyState, Skeleton, Tooltip } from '@/components/ui';
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
import {
	allSqlStatements,
	applySqlTarget,
	completionSchemaSummary,
	csvCell,
	defaultSql,
	sqlDialectSettings,
	sqlTargetAtState,
} from './sqlWorkspaceUtils';
import type { QueryDialect, SqlTarget } from './sqlWorkspaceUtils';

interface Selection {
	namespace: string[];
	table: string;
}

interface QueryTable {
	namespace: string[];
	name: string;
	columns: { name: string; type: string; nullable: boolean }[];
}

export interface QueryResult {
	columns: string[];
	rows: unknown[][];
	truncated: boolean;
	execution_ms: number;
}

export interface QueryExecution {
	id: number;
	sql: string;
	result: QueryResult;
}

interface SqlEditorHandle {
	getSql(): string;
	getRunTarget(): SqlTarget;
	getAllSql(): string[];
	replaceSql(sql: string): void;
	replaceTarget(target: SqlTarget, sql: string): boolean;
	format(): void;
	focus(): void;
}

interface EditorReadinessStore {
	getSnapshot(): boolean;
	setReady(ready: boolean): void;
	subscribe(listener: () => void): () => void;
}

function createEditorReadinessStore(): EditorReadinessStore {
	let ready = false;
	const listeners = new Set<() => void>();
	return {
		getSnapshot: () => ready,
		setReady: (nextReady) => {
			if (ready === nextReady) return;
			ready = nextReady;
			for (const listener of listeners) listener();
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

const MAX_HISTORY = 20;

async function importSqlEditorRuntime() {
	const [core, commands, lint, state, view, langSql, marimoSql, dialects] = await Promise.all([
		import('codemirror'),
		import('@codemirror/commands'),
		import('@codemirror/lint'),
		import('@codemirror/state'),
		import('@codemirror/view'),
		import('@codemirror/lang-sql'),
		import('@marimo-team/codemirror-sql'),
		import('@marimo-team/codemirror-sql/dialects'),
	]);
	return {
		...core,
		...commands,
		...lint,
		...state,
		...view,
		...langSql,
		...marimoSql,
		...dialects,
	};
}

type SqlEditorRuntime = Awaited<ReturnType<typeof importSqlEditorRuntime>>;
let sqlEditorRuntimePromise: Promise<SqlEditorRuntime> | undefined;

function loadSqlEditorRuntime(): Promise<SqlEditorRuntime> {
	if (!sqlEditorRuntimePromise) {
		const pending = importSqlEditorRuntime();
		sqlEditorRuntimePromise = pending;
		void pending.catch(() => {
			if (sqlEditorRuntimePromise === pending) sqlEditorRuntimePromise = undefined;
		});
	}
	return sqlEditorRuntimePromise;
}

interface SqlWorkspaceProps {
	projectId: string;
	integrationId: string;
	integrationName: string;
	selection: Selection | null;
	aiAvailable: boolean;
	dialect?: QueryDialect;
}

export default function SqlWorkspace(props: SqlWorkspaceProps) {
	const { data: user } = useUserQuery();
	const storageKey = `marimohub:sql:${user?.id ?? 'unknown'}:${props.projectId}:${props.integrationId}`;
	return <SqlWorkspaceSession key={storageKey} {...props} storageKey={storageKey} />;
}

function SqlWorkspaceSession({
	projectId,
	integrationId,
	integrationName,
	selection,
	aiAvailable,
	dialect = 'duckdb',
	storageKey,
}: SqlWorkspaceProps & { storageKey: string }) {
	const schemaQuery = useDataQuerySchemaQuery(projectId, integrationId, selection);
	const query = useRunDataQuery(projectId, integrationId);
	const generate = useGenerateDataQuerySql(projectId, integrationId);
	const editorRef = useRef<SqlEditorHandle>(null);
	const abortRef = useRef<AbortController>(null);
	const stored = useMemo(() => readStoredWorkspace(storageKey), [storageKey]);
	const [executions, setExecutions] = useState<QueryExecution[]>([]);
	const [activeResultIndex, setActiveResultIndex] = useState(0);
	const [historyItems, setHistoryItems] = useState<string[]>(stored.history);
	const [instruction, setInstruction] = useState('');
	const [showHistory, setShowHistory] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const editorReadiness = useMemo(createEditorReadinessStore, []);
	const editorReady = useSyncExternalStore(
		editorReadiness.subscribe,
		editorReadiness.getSnapshot,
		editorReadiness.getSnapshot,
	);
	const [lastLoadedSchema, setLastLoadedSchema] = useState<typeof schemaQuery.data>(undefined);
	const [fullscreen, setFullscreen] = useState(false);
	const { copy, copied } = useCopyToClipboard();

	useEffect(() => () => abortRef.current?.abort(), []);

	useEffect(() => {
		if (!fullscreen) return;
		const onKeyDown = (event: KeyboardEvent) => {
			// defaultPrevented: Escape was consumed inside the editor (e.g. closing
			// the completion popup) and should not also exit fullscreen.
			if (event.key === 'Escape' && !event.defaultPrevented) setFullscreen(false);
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [fullscreen]);

	const persistDraft = useCallback(
		(sqlText: string) =>
			writeStoredWorkspace(storageKey, { draft: sqlText, history: historyItems }),
		[historyItems, storageKey],
	);

	const run = useCallback(
		async (all = false) => {
			const sqlTexts = all
				? (editorRef.current?.getAllSql() ?? [])
				: [editorRef.current?.getRunTarget().sql ?? ''];
			if (sqlTexts.every((sqlText) => !sqlText.trim())) return;
			abortRef.current?.abort();
			const controller = new AbortController();
			abortRef.current = controller;
			setError(null);
			setExecutions([]);
			setActiveResultIndex(0);
			try {
				const statements = sqlTexts.filter((sqlText) => sqlText.trim());
				let completed: QueryExecution[] = [];
				let nextHistory = historyItems;
				const executeStatement = async (index: number): Promise<void> => {
					const sqlText = statements[index];
					if (sqlText === undefined) return;
					if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
					const data = await query.mutateAsync({ sql: sqlText, signal: controller.signal });
					if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
					completed = [...completed, { id: index, sql: sqlText, result: data as QueryResult }];
					setExecutions(completed);
					setActiveResultIndex(index);
					nextHistory = [sqlText, ...nextHistory.filter((item) => item !== sqlText)].slice(
						0,
						MAX_HISTORY,
					);
					setHistoryItems(nextHistory);
					writeStoredWorkspace(storageKey, {
						draft: editorRef.current?.getSql() ?? sqlText,
						history: nextHistory,
					});
					return executeStatement(index + 1);
				};
				await executeStatement(0);
			} catch (cause) {
				if (!controller.signal.aborted) setError(errorMessage(cause));
			} finally {
				if (abortRef.current === controller) abortRef.current = null;
			}
		},
		[historyItems, query, storageKey],
	);

	const generateSql = async () => {
		if (!editorReady || !instruction.trim()) return;
		setError(null);
		try {
			const target = editorRef.current?.getRunTarget();
			const current = target?.sql ?? '';
			const data = await generate.mutateAsync({
				mode: current.trim() ? 'revise' : 'generate',
				instruction,
				...(current.trim() ? { sql: current } : {}),
			});
			if (!target || !editorRef.current?.replaceTarget(target, data.sql)) {
				setError('The SQL changed while AI was generating. Review the changes and try again.');
				return;
			}
			editorRef.current?.focus();
			setInstruction('');
		} catch (cause) {
			setError(errorMessage(cause));
		}
	};

	// Retain the last loaded schema so table clicks (new query key) and refresh
	// failures never unmount the editor and discard the user's draft.
	if (schemaQuery.data !== undefined && schemaQuery.data !== lastLoadedSchema) {
		setLastLoadedSchema(schemaQuery.data);
	}
	const schema = schemaQuery.data ?? lastLoadedSchema;
	if (schema === undefined) {
		if (schemaQuery.isError) {
			return (
				<EmptyState
					icon={<Bot />}
					message="SQL schema unavailable"
					description={errorMessage(schemaQuery.error)}
				/>
			);
		}
		return <Skeleton className="h-full min-h-96 w-full" />;
	}
	return (
		<div
			className={cn(
				'flex min-h-[34rem] flex-col overflow-hidden border bg-card',
				fullscreen ? 'fixed inset-0 z-50 rounded-none' : 'rounded-xl',
			)}
		>
			<div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
				<Button
					size="sm"
					variant="primary"
					onPress={() => void run(false)}
					isDisabled={!editorReady || query.isPending}
				>
					<Play className="size-3.5" /> Run
				</Button>
				<Button
					size="sm"
					onPress={() => void run(true)}
					isDisabled={!editorReady || query.isPending}
				>
					Run all
				</Button>
				{query.isPending ? (
					<Button size="sm" variant="danger" onPress={() => abortRef.current?.abort()}>
						<Square className="size-3.5" /> Cancel
					</Button>
				) : null}
				<Button
					size="sm"
					variant="ghost"
					onPress={() => editorRef.current?.format()}
					isDisabled={!editorReady}
				>
					<WandSparkles className="size-3.5" /> Format
				</Button>
				<Button
					size="sm"
					variant="ghost"
					onPress={() => void copy(editorRef.current?.getSql() ?? '')}
					isDisabled={!editorReady}
				>
					<Clipboard className="size-3.5" /> {copied ? 'Copied' : 'Copy SQL'}
				</Button>
				<Button size="sm" variant="ghost" onPress={() => setShowHistory((value) => !value)}>
					<HistoryIcon className="size-3.5" /> History
				</Button>
				<Button
					size="sm"
					variant="ghost"
					onPress={() => editorRef.current?.replaceSql('')}
					isDisabled={!editorReady}
				>
					<Eraser className="size-3.5" /> Clear
				</Button>
				<span className="ml-auto text-xs text-muted-foreground">
					⌘/Ctrl+Enter runs the selection or current statement
				</span>
				<Button
					size="sm"
					variant="ghost"
					aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
					onPress={() => setFullscreen((value) => !value)}
				>
					{fullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
				</Button>
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
						isDisabled={!editorReady || generate.isPending || !instruction.trim()}
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
							disabled={!editorReady}
							className="block w-full truncate rounded px-2 py-1 text-left font-mono text-xs hover:bg-muted"
						>
							{item.replaceAll(/\s+/g, ' ')}
						</button>
					))}
				</div>
			) : null}
			<SqlEditor
				ref={editorRef}
				initialSql={stored.draft || defaultSql(dialect)}
				tables={schema.tables}
				integrationName={integrationName}
				dialect={dialect}
				onRun={() => void run(false)}
				onChange={persistDraft}
				readiness={editorReadiness}
			/>
			{schemaQuery.isFetching ? (
				<output className="block border-t px-3 py-2 text-xs text-muted-foreground">
					Updating completions…
				</output>
			) : schemaQuery.isError ? (
				<p className="border-t bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
					Couldn’t refresh completions; showing the last loaded schema.
				</p>
			) : null}
			{schema.truncated.tables || schema.truncated.columns || schema.truncated.bytes ? (
				<p className="flex items-center gap-1.5 border-t bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
					Completion schema is bounded; some tables or columns were omitted.
					<Tooltip content={completionSchemaSummary(schema.counts)}>
						<button
							type="button"
							aria-label="Completion schema details"
							className="inline-flex rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<Info className="size-3.5" />
						</button>
					</Tooltip>
				</p>
			) : null}
			<div className="min-h-56 flex-1 overflow-auto border-t p-3">
				{error ? <p className="mb-3 text-sm text-destructive">{error}</p> : null}
				{query.isPending ? (
					<output aria-label="Running query" className="block">
						<Skeleton className="h-32 w-full" />
					</output>
				) : executions.length > 0 ? (
					<QueryExecutionResults
						executions={executions}
						activeIndex={activeResultIndex}
						onSelect={setActiveResultIndex}
					/>
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
		dialect,
		onRun,
		onChange,
		readiness,
	}: {
		initialSql: string;
		tables: QueryTable[];
		integrationName: string;
		dialect: QueryDialect;
		onRun: () => void;
		onChange: (sql: string) => void;
		readiness: EditorReadinessStore;
	},
	ref: Ref<SqlEditorHandle>,
) {
	const parentRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView>(null);
	const runtimeRef = useRef<SqlEditorRuntime>(null);
	const schemaCompartmentRef = useRef<Compartment>(null);
	const themeCompartmentRef = useRef<Compartment>(null);
	const analyzersRef = useRef<{ parser: NodeSqlParser; contextAnalyzer: QueryContextAnalyzer }>(
		null,
	);
	const onRunRef = useRef(onRun);
	const onChangeRef = useRef(onChange);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [loadAttempt, setLoadAttempt] = useState(0);
	const { theme } = useTheme();
	const schema = useMemo(
		() => completionSchema(tables, integrationName),
		[tables, integrationName],
	);
	const latestSchemaRef = useRef(schema);
	const latestThemeRef = useRef(theme);
	useEffect(() => {
		onRunRef.current = onRun;
		onChangeRef.current = onChange;
	}, [onChange, onRun]);
	useEffect(() => {
		latestSchemaRef.current = schema;
	}, [schema]);
	useEffect(() => {
		latestThemeRef.current = theme;
	}, [theme]);

	useImperativeHandle(ref, () => ({
		getSql: () => viewRef.current?.state.doc.toString() ?? '',
		getRunTarget: () =>
			viewRef.current
				? sqlTargetAtState(viewRef.current.state)
				: { from: 0, to: 0, sql: '', document: '' },
		getAllSql: () =>
			viewRef.current ? allSqlStatements(viewRef.current.state.doc.toString()) : [],
		replaceSql: (next) => {
			const view = viewRef.current;
			const runtime = runtimeRef.current;
			if (!view || !runtime) return;
			view.dispatch({
				changes: { from: 0, to: view.state.doc.length, insert: next },
				selection: runtime.EditorSelection.cursor(next.length),
			});
		},
		replaceTarget: (target, next) => {
			const view = viewRef.current;
			const runtime = runtimeRef.current;
			if (
				!view ||
				!runtime ||
				applySqlTarget(view.state.doc.toString(), target, next) === undefined
			) {
				return false;
			}
			view.dispatch({
				changes: { from: target.from, to: target.to, insert: next },
				selection: runtime.EditorSelection.cursor(target.from + next.length),
			});
			return true;
		},
		format: () => {
			const view = viewRef.current;
			if (!view) return;
			try {
				const formatted = formatSql(view.state.doc.toString(), {
					language: sqlDialectSettings(dialect).formatterLanguage,
					keywordCase: 'upper',
				});
				view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: formatted } });
			} catch {}
		},
		focus: () => viewRef.current?.focus(),
	}));

	useEffect(() => {
		if (!parentRef.current) return;
		let cancelled = false;
		let loadedView: EditorView | undefined;
		setLoadError(null);
		readiness.setReady(false);
		void loadSqlEditorRuntime()
			.then((runtime) => {
				if (cancelled || !parentRef.current) return;
				const parser = new runtime.NodeSqlParser({
					getParserOptions: () => ({ database: sqlDialectSettings(dialect).parserDatabase }),
				});
				const contextAnalyzer = new runtime.QueryContextAnalyzer(parser);
				const schemaCompartment = new runtime.Compartment();
				const themeCompartment = new runtime.Compartment();
				runtimeRef.current = runtime;
				schemaCompartmentRef.current = schemaCompartment;
				themeCompartmentRef.current = themeCompartment;
				analyzersRef.current = { parser, contextAnalyzer };
				loadedView = new runtime.EditorView({
					parent: parentRef.current,
					doc: initialSql,
					extensions: [
						runtime.basicSetup,
						runtime.lintGutter(),
						// basicSetup binds Mod-Enter to insertBlankLine; this keeps Run first.
						runtime.Prec.high(
							runtime.keymap.of([
								{
									key: 'Mod-Enter',
									run: () => {
										onRunRef.current();
										return true;
									},
								},
								runtime.indentWithTab,
							]),
						),
						runtime.EditorView.updateListener.of((update) => {
							if (update.docChanged) onChangeRef.current(update.state.doc.toString());
						}),
						schemaCompartment.of(
							schemaExtensions(runtime, latestSchemaRef.current, dialect, parser, contextAnalyzer),
						),
						themeCompartment.of(editorTheme(runtime, latestThemeRef.current)),
					],
				});
				viewRef.current = loadedView;
				readiness.setReady(true);
			})
			.catch((cause: unknown) => {
				if (!cancelled) setLoadError(errorMessage(cause));
			});
		return () => {
			cancelled = true;
			loadedView?.destroy();
			if (viewRef.current === loadedView) viewRef.current = null;
		};
	}, [dialect, initialSql, loadAttempt, readiness]);

	useEffect(() => {
		const runtime = runtimeRef.current;
		const view = viewRef.current;
		const compartment = schemaCompartmentRef.current;
		if (!runtime || !view || !compartment) return;
		view.dispatch({
			effects: compartment.reconfigure(
				schemaExtensions(
					runtime,
					schema,
					dialect,
					analyzersRef.current?.parser,
					analyzersRef.current?.contextAnalyzer,
				),
			),
		});
	}, [dialect, schema]);

	useEffect(() => {
		const runtime = runtimeRef.current;
		const view = viewRef.current;
		const compartment = themeCompartmentRef.current;
		if (!runtime || !view || !compartment) return;
		view.dispatch({ effects: compartment.reconfigure(editorTheme(runtime, theme)) });
	}, [theme]);

	return (
		<div className="min-h-56 overflow-auto font-mono text-sm">
			{loadError ? (
				<div role="alert" className="flex min-h-56 flex-col items-center justify-center gap-3 p-4">
					<p className="text-destructive">Couldn’t load the SQL editor: {loadError}</p>
					<Button size="sm" onPress={() => setLoadAttempt((attempt) => attempt + 1)}>
						Retry
					</Button>
				</div>
			) : null}
			<div ref={parentRef} className={loadError ? 'hidden' : undefined} />
		</div>
	);
});

function schemaExtensions(
	runtime: SqlEditorRuntime,
	schema: Record<string, string[]>,
	dialect: QueryDialect,
	parser = new runtime.NodeSqlParser({
		getParserOptions: () => ({ database: sqlDialectSettings(dialect).parserDatabase }),
	}),
	contextAnalyzer = new runtime.QueryContextAnalyzer(parser),
) {
	const sqlDialect = dialect === 'postgresql' ? runtime.PostgreSQL : runtime.DuckDBDialect;
	return [
		runtime.sql({ dialect: sqlDialect, schema, upperCaseKeywords: true }),
		...runtime.sqlCompletion({ dialect: sqlDialect, schema, parser, contextAnalyzer }),
		...runtime.sqlExtension({
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
	];
}

function editorTheme(runtime: SqlEditorRuntime, theme: 'light' | 'dark') {
	return runtime.EditorView.theme(
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

export function QueryExecutionResults({
	executions,
	activeIndex,
	onSelect,
}: {
	executions: QueryExecution[];
	activeIndex: number;
	onSelect: (index: number) => void;
}) {
	const selectedIndex = Math.min(Math.max(activeIndex, 0), executions.length - 1);
	const execution = executions[selectedIndex];
	const tabSetId = useId();
	if (!execution) return null;

	return (
		<div>
			{executions.length > 1 ? (
				<div
					role="tablist"
					aria-label="Query results"
					className="mb-3 flex gap-1 overflow-x-auto border-b"
				>
					{executions.map((item, index) => (
						<button
							type="button"
							role="tab"
							id={`${tabSetId}-tab-${index}`}
							aria-controls={`${tabSetId}-panel`}
							aria-label={`Statement ${index + 1}, ${item.result.rows.length.toLocaleString()} ${item.result.rows.length === 1 ? 'row' : 'rows'}`}
							aria-selected={index === selectedIndex}
							tabIndex={index === selectedIndex ? 0 : -1}
							title={item.sql.replaceAll(/\s+/g, ' ').trim()}
							key={item.id}
							onClick={() => onSelect(index)}
							onKeyDown={(event) => {
								const nextIndex =
									event.key === 'ArrowRight'
										? (index + 1) % executions.length
										: event.key === 'ArrowLeft'
											? (index - 1 + executions.length) % executions.length
											: event.key === 'Home'
												? 0
												: event.key === 'End'
													? executions.length - 1
													: undefined;
								if (nextIndex === undefined) return;
								event.preventDefault();
								onSelect(nextIndex);
								const tabs =
									event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]');
								tabs?.[nextIndex]?.focus();
							}}
							className={cn(
								'shrink-0 border-b-2 px-3 py-2 text-xs',
								index === selectedIndex
									? 'border-primary font-medium text-foreground'
									: 'border-transparent text-muted-foreground hover:text-foreground',
							)}
						>
							Statement {index + 1}
							<span className="ml-1 text-muted-foreground">
								({item.result.rows.length.toLocaleString()}{' '}
								{item.result.rows.length === 1 ? 'row' : 'rows'})
							</span>
						</button>
					))}
				</div>
			) : null}
			<div
				role="tabpanel"
				id={`${tabSetId}-panel`}
				aria-labelledby={executions.length > 1 ? `${tabSetId}-tab-${selectedIndex}` : undefined}
				aria-label={executions.length === 1 ? 'Query result' : undefined}
			>
				{executions.length > 1 ? (
					<p
						className="mb-2 truncate font-mono text-xs text-muted-foreground"
						title={execution.sql}
					>
						{execution.sql.replaceAll(/\s+/g, ' ').trim()}
					</p>
				) : null}
				<QueryResultTable key={selectedIndex} result={execution.result} />
			</div>
		</div>
	);
}

function QueryResultTable({ result }: { result: QueryResult }) {
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
										<td key={columnKey} className="max-w-96 p-0 font-mono">
											<button
												type="button"
												title="Copy cell"
												onClick={() => void navigator.clipboard.writeText(rendered)}
												className={cn(
													'w-full cursor-copy truncate px-3 py-1.5 text-left',
													rendered === 'null' && 'italic text-muted-foreground',
												)}
											>
												{rendered}
											</button>
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
