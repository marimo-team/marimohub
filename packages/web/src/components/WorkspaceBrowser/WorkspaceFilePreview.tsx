import { Finder, formatFileSize, useFinderStore } from '@marimo-team/react-finder';
import type { FileItem, PreviewContent } from '@marimo-team/react-finder';
import type { EditorView } from '@codemirror/view';
import { useQueryClient } from '@tanstack/react-query';
import { Download, File, Save } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { notebookKeys } from '@/api/queryKeys';
import { Button } from '@/components/ui';
import { triggerDownload } from '@/lib/download';
import type { WorkspaceAccess } from './workspacePolicy';
import {
	decodeWorkspaceText,
	isWorkspaceTextFile,
	MAX_TEXT_EDITOR_BYTES,
} from './workspacePreview';

function CodeEditor({
	value,
	readOnly,
	onChange,
	onSave,
}: {
	value: string;
	readOnly: boolean;
	onChange: (value: string) => void;
	onSave: () => void;
}) {
	const host = useRef<HTMLDivElement>(null);
	const initialValue = useRef(value).current;
	const saveRef = useRef(onSave);
	const changeRef = useRef(onChange);
	useEffect(() => {
		saveRef.current = onSave;
		changeRef.current = onChange;
	}, [onChange, onSave]);

	useEffect(() => {
		if (!host.current) return;
		let cancelled = false;
		let view: EditorView | undefined;
		void Promise.all([
			import('codemirror'),
			import('@codemirror/state'),
			import('@codemirror/view'),
		]).then(([{ basicSetup }, { EditorState }, { EditorView, keymap }]) => {
			if (cancelled || !host.current) return;
			view = new EditorView({
				parent: host.current,
				state: EditorState.create({
					doc: initialValue,
					extensions: [
						basicSetup,
						EditorState.readOnly.of(readOnly),
						EditorView.lineWrapping,
						EditorView.updateListener.of((update) => {
							if (update.docChanged) changeRef.current(update.state.doc.toString());
						}),
						keymap.of([
							{
								key: 'Mod-s',
								preventDefault: true,
								run: () => {
									saveRef.current();
									return true;
								},
							},
						]),
						EditorView.theme({
							'&': { height: '100%', fontSize: '13px' },
							'.cm-scroller': { overflow: 'auto' },
						}),
					],
				}),
			});
		});
		return () => {
			cancelled = true;
			view?.destroy();
		};
	}, [initialValue, readOnly]);

	return <div ref={host} className="min-h-0 flex-1 overflow-hidden border-t" />;
}

export function WorkspaceFilePreview({
	path,
	access,
	onDirtyChange,
}: {
	path: string | null;
	access: WorkspaceAccess;
	onDirtyChange: (dirty: boolean) => void;
}) {
	return (
		<Finder.Preview path={path ?? undefined} read>
			{({ item, content }) => (
				<FilePreviewContent
					key={`${item?.path ?? ''}:${item?.modifiedAt ?? ''}`}
					item={item}
					content={content}
					access={access}
					onDirtyChange={onDirtyChange}
				/>
			)}
		</Finder.Preview>
	);
}

function FilePreviewContent({
	item,
	content,
	access,
	onDirtyChange,
}: {
	item: FileItem | null;
	content: PreviewContent;
	access: WorkspaceAccess;
	onDirtyChange: (dirty: boolean) => void;
}) {
	const store = useFinderStore();
	const queryClient = useQueryClient();
	const [loadedText, setLoadedText] = useState<string | null>(null);
	const [text, setText] = useState<string | null>(null);
	const [textError, setTextError] = useState(false);
	const [saving, setSaving] = useState(false);
	const blob = content.blob;
	const textLike = item ? isWorkspaceTextFile(item) : false;

	useEffect(() => {
		let cancelled = false;
		if (!blob || !textLike || blob.size > MAX_TEXT_EDITOR_BYTES) return;
		void blob.arrayBuffer().then((buffer) => {
			if (cancelled) return;
			const value = decodeWorkspaceText(buffer);
			if (value === null) {
				setTextError(true);
				return;
			}
			setLoadedText(value);
			setText(value);
			setTextError(false);
			onDirtyChange(false);
		});
		return () => {
			cancelled = true;
		};
	}, [blob, onDirtyChange, textLike]);

	if (!item) {
		return (
			<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
				Select a file to preview it.
			</div>
		);
	}
	if (item.kind === 'directory') {
		return (
			<div className="p-4 text-sm text-muted-foreground">
				Open the folder to browse its contents.
			</div>
		);
	}
	if (content.status === 'loading') {
		return <div className="p-4 text-sm text-muted-foreground">Loading preview…</div>;
	}
	if (content.status === 'error') {
		return (
			<div className="p-4 text-sm text-destructive">
				{content.error?.message ?? 'Could not load file'}
			</div>
		);
	}
	if (!blob) return null;

	const dirty = text !== null && loadedText !== null && text !== loadedText;
	const save = async () => {
		if (text === null || !dirty || !access.writable) return;
		setSaving(true);
		try {
			await store.getState().writeFile(item.path, text);
			setLoadedText(text);
			onDirtyChange(false);
			await queryClient.invalidateQueries({ queryKey: notebookKeys.all });
			toast.success(`Saved ${item.name}`);
		} catch {
			// The finder store owns adapter error reporting.
		} finally {
			setSaving(false);
		}
	};

	if (textLike && blob.size <= MAX_TEXT_EDITOR_BYTES && !textError && text !== null) {
		return (
			<div className="flex h-full min-h-0 flex-col">
				<div className="flex items-center justify-between gap-2 p-2">
					<div className="min-w-0">
						<div className="truncate text-sm font-medium">{item.name}</div>
						<div className="text-xs text-muted-foreground">{formatFileSize(item.size)}</div>
					</div>
					<Button
						size="sm"
						variant="primary"
						isDisabled={!dirty || saving || !access.writable}
						onPress={() => void save()}
					>
						<Save className="size-3.5" />
						{saving ? 'Saving…' : 'Save'}
					</Button>
				</div>
				<CodeEditor
					value={text}
					readOnly={!access.writable}
					onChange={(next) => {
						setText(next);
						onDirtyChange(next !== loadedText);
					}}
					onSave={() => void save()}
				/>
			</div>
		);
	}

	if (item.mimeType?.startsWith('image/') && content.url) {
		return (
			<div className="flex h-full items-center justify-center overflow-auto p-4">
				<img src={content.url} alt={item.name} className="max-h-full max-w-full object-contain" />
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col items-center justify-center gap-3 p-5 text-center">
			<File className="size-10 text-muted-foreground" />
			<div>
				<div className="font-medium">{item.name}</div>
				<div className="text-sm text-muted-foreground">
					{formatFileSize(item.size)} · {item.mimeType ?? 'Binary file'}
				</div>
			</div>
			<Button onPress={() => triggerDownload(item.name, blob)}>
				<Download className="size-4" />
				Download
			</Button>
		</div>
	);
}
