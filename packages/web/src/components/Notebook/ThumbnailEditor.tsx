import { useRef, useState } from 'react';
import { DropZone, FileTrigger } from 'react-aria-components';
import ReactCrop, { centerCrop, makeAspectCrop } from 'react-image-crop';
import type { PercentCrop } from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';
import { Button, FormDialog } from '@/components/ui';
import { useThumbnail, useSaveThumbnail } from '@/api/thumbnails';
import {
	cropThumbnail,
	isValidCrop,
	readThumbnailImage,
	THUMBNAIL_ASPECT,
	THUMBNAIL_FILE_TYPES,
} from './thumbnailCrop';

export default function ThumbnailEditor({
	projectId,
	notebookId,
	onClose,
}: {
	projectId: string;
	notebookId: string;
	onClose: () => void;
}) {
	const { data } = useThumbnail(projectId, notebookId);
	const save = useSaveThumbnail(projectId, notebookId);
	const [source, setSource] = useState<{ src: string; id: number }>();
	const src = source?.src;
	const [crop, setCrop] = useState<PercentCrop>();
	const [error, setError] = useState('');
	const [working, setWorking] = useState(false);
	const [loading, setLoading] = useState(false);
	const image = useRef<HTMLImageElement>(null);
	const selection = useRef(0);
	const busy = working || save.isPending;
	async function select(file?: File | Promise<File>) {
		if (!file || busy) return;
		const token = ++selection.current;
		setLoading(true);
		setError('');
		try {
			const src = await readThumbnailImage(await file);
			if (token !== selection.current) return;
			setCrop(undefined);
			setSource({ src, id: token });
		} catch (error) {
			if (token === selection.current) {
				setError(
					error instanceof Error
						? error.message
						: 'This image could not be opened. Try another screenshot.',
				);
			}
		}
		if (token === selection.current) setLoading(false);
	}
	function close() {
		if (busy) return;
		selection.current++;
		onClose();
	}

	async function submit() {
		if (!image.current || !crop || !isValidCrop(crop) || loading || busy) return;
		setWorking(true);
		setError('');
		try {
			await save.mutateAsync(await cropThumbnail(image.current, crop));
			onClose();
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Could not save thumbnail');
		}
		setWorking(false);
	}
	return (
		<div
			className="contents"
			onPaste={(event) => {
				const file = [...event.clipboardData.files].find((f) => f.type.startsWith('image/'));
				if (file) {
					event.preventDefault();
					void select(file);
				}
			}}
		>
			<FormDialog
				title="Edit thumbnail"
				isOpen
				onClose={close}
				width="lg"
				submitLabel="Save thumbnail"
				pendingLabel="Saving…"
				isPending={busy}
				submitDisabled={loading || !src || !crop || !isValidCrop(crop)}
				onSubmit={() => void submit()}
			>
				<div className="flex flex-col gap-3">
					<p className="text-sm text-muted-foreground">
						Capture the part of your notebook or app you want to show. Upload or paste the
						screenshot, adjust the crop, then select Save thumbnail.
					</p>
					<details className="text-xs text-muted-foreground">
						<summary className="cursor-pointer">Screenshot shortcuts</summary>
						<p className="mt-2">
							Mac: ⇧⌘4 selects an area; hold Control to copy it.
							<br />
							Windows: Win+Shift+S selects and copies an area.
							<br />
							Paste with ⌘V or Ctrl+V, or choose Upload image.
						</p>
					</details>
					<DropZone
						aria-label="Upload or paste a thumbnail"
						isDisabled={busy}
						className="rounded-lg border border-dashed p-4 text-center outline-none data-[drop-target]:border-primary focus-visible:ring-2 focus-visible:ring-ring"
						onDrop={(event) => {
							const item = event.items.find((i) => i.kind === 'file');
							if (item?.kind === 'file') void select(item.getFile());
						}}
					>
						<FileTrigger
							acceptedFileTypes={THUMBNAIL_FILE_TYPES}
							onSelect={(files) => void select(files?.[0])}
						>
							<Button isDisabled={busy}>Upload image</Button>
						</FileTrigger>
						<p className="mt-2 text-xs text-muted-foreground">
							Or drop or paste an image here. PNG, JPEG, WebP · up to 10 MB
						</p>
					</DropZone>
					{src && (
						<ReactCrop
							crop={crop}
							aspect={THUMBNAIL_ASPECT}
							keepSelection
							disabled={busy || loading}
							onChange={(_, percent) => setCrop(percent)}
						>
							<img
								key={source?.id}
								ref={image}
								src={src}
								alt="Screenshot to crop"
								className="max-h-[45vh] max-w-full"
								onLoad={(event) => {
									const { width, height } = event.currentTarget;
									setCrop(
										centerCrop(
											makeAspectCrop({ unit: '%', width: 100 }, THUMBNAIL_ASPECT, width, height),
											width,
											height,
										),
									);
								}}
							/>
						</ReactCrop>
					)}
					{src && crop && isValidCrop(crop) && (
						<div className="w-60 max-w-full">
							<p className="mb-1 text-xs text-muted-foreground">Thumbnail preview</p>
							<div
								className="aspect-video overflow-hidden rounded border bg-white"
								style={{
									backgroundImage: `url(${src})`,
									backgroundRepeat: 'no-repeat',
									backgroundSize: `${10000 / crop.width}% ${10000 / crop.height}%`,
									backgroundPosition: `${crop.width === 100 ? 0 : (crop.x / (100 - crop.width)) * 100}% ${crop.height === 100 ? 0 : (crop.y / (100 - crop.height)) * 100}%`,
								}}
							/>
						</div>
					)}
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					{data?.has_custom && (
						<Button
							variant="ghost"
							isDisabled={busy || loading}
							onPress={() => {
								setError('');
								void save
									.mutateAsync(null)
									.then(onClose)
									.catch((e: unknown) =>
										setError(e instanceof Error ? e.message : 'Could not remove thumbnail'),
									);
							}}
						>
							Remove custom thumbnail
						</Button>
					)}
					<p className="text-xs text-muted-foreground">
						Your thumbnail is visible to people who can view this notebook.
					</p>
				</div>
			</FormDialog>
		</div>
	);
}
