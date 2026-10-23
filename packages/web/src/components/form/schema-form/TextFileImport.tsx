import { useLayoutEffect, useRef, useState } from 'react';
import { FileTrigger } from 'react-aria-components';
import { Button } from '@/components/ui';

export function TextFileImport({
	label,
	accept,
	maxBytes = 64 * 1024,
	onChange,
}: {
	label: string;
	accept: string[];
	maxBytes?: number;
	onChange: (text: string) => void;
}) {
	const [error, setError] = useState<string>();
	const selection = useRef(0);
	const latestOnChange = useRef(onChange);
	useLayoutEffect(() => {
		latestOnChange.current = onChange;
	});
	useLayoutEffect(
		() => () => {
			selection.current++;
		},
		[],
	);
	const importFile = async (files: FileList | null) => {
		const current = ++selection.current;
		const file = files?.[0];
		if (!file) return;
		setError(undefined);
		if (file.size > maxBytes) {
			setError(`File must be at most ${maxBytes} bytes.`);
			return;
		}
		try {
			const bytes = await file.arrayBuffer();
			const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
			if (current === selection.current) latestOnChange.current(text);
		} catch {
			if (current === selection.current)
				setError('Could not read this file. Try importing it again.');
		}
	};
	return (
		<div className="flex flex-col items-start gap-1.5">
			<FileTrigger acceptedFileTypes={accept} onSelect={(files) => void importFile(files)}>
				<Button size="sm" aria-label={`Import file for ${label}`}>
					Import file
				</Button>
			</FileTrigger>
			{error && (
				<p role="alert" className="text-xs text-destructive">
					{error}
				</p>
			)}
		</div>
	);
}
