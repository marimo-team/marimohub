import { useId, useMemo, useRef, useState } from 'react';
import type {
	HTMLAttributes,
	PointerEvent as ReactPointerEvent,
	ReactNode,
	RefObject,
} from 'react';
import { Button, Tab, TabList, Tabs, useDrag, useDrop } from 'react-aria-components';
import { ExternalLink, GripVertical, PanelRightClose, PanelRightOpen, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from './ConfirmDialog';

/* oxlint-disable jsx-a11y/prefer-tag-over-role -- An adjustable separator must be focusable and interactive. */

const APPLICATION_TAB_DRAG_TYPE = 'application/x-marimohub-application-tab';
const DEFAULT_SPLIT_SIZE = 50;
const MIN_SPLIT_SIZE = 20;
const MAX_SPLIT_SIZE = 80;

export interface ApplicationTabCloseConfirmation {
	title: string;
	description: ReactNode;
	confirmLabel?: string;
	pendingLabel?: string;
}

export interface ApplicationTabItem {
	id: string;
	label: string;
	icon: ReactNode;
	panel: ReactNode;
	isDisabled?: boolean;
	close?: ApplicationTabCloseConfirmation;
	browserUrl?: string;
	isSplittable?: boolean;
	panelClassName?: string;
}

export interface ApplicationTabsProps {
	ariaLabel: string;
	tabs: readonly ApplicationTabItem[];
	selectedKey?: string;
	defaultSelectedKey?: string;
	onSelectionChange?: (key: string) => void;
	order?: readonly string[];
	defaultOrder?: readonly string[];
	onOrderChange?: (keys: readonly string[]) => void;
	onClose?: (tab: ApplicationTabItem) => void | Promise<void>;
	onCloseError?: (error: unknown, tab: ApplicationTabItem) => void;
	allowsSplitView?: boolean;
	splitKey?: string | null;
	defaultSplitKey?: string | null;
	onSplitKeyChange?: (key: string | null) => void;
	splitSize?: number;
	defaultSplitSize?: number;
	onSplitSizeChange?: (size: number) => void;
	actions?: ReactNode;
	className?: string;
	tabListClassName?: string;
	panelsClassName?: string;
}

type DropPosition = 'before' | 'after';

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((key, index) => key === right[index]);
}

function reconcileOrder(order: readonly string[], availableKeys: readonly string[]): string[] {
	const available = new Set(availableKeys);
	const next = order.filter((key) => available.has(key));
	const included = new Set(next);

	for (const key of availableKeys) {
		if (!included.has(key)) next.push(key);
	}

	return next;
}

function moveKey(
	order: readonly string[],
	sourceKey: string,
	targetKey: string,
	position: DropPosition,
): string[] {
	if (sourceKey === targetKey || !order.includes(sourceKey) || !order.includes(targetKey)) {
		return [...order];
	}

	const next = order.filter((key) => key !== sourceKey);
	const targetIndex = next.indexOf(targetKey);
	const insertionIndex = position === 'after' ? targetIndex + 1 : targetIndex;
	next.splice(insertionIndex, 0, sourceKey);
	return next;
}

function clampSplitSize(size: number): number {
	if (!Number.isFinite(size)) return DEFAULT_SPLIT_SIZE;
	return Math.min(MAX_SPLIT_SIZE, Math.max(MIN_SPLIT_SIZE, size));
}

function useStablePanelOrder(tabKeys: readonly string[]): string[] {
	const [panelOrder, setPanelOrder] = useState(() => [...tabKeys]);
	const nextPanelOrder = reconcileOrder(panelOrder, tabKeys);

	if (!sameKeys(panelOrder, nextPanelOrder)) {
		// Panel order records mount history. Keeping it separate from the visible
		// tab order prevents React from moving a mounted iframe during reordering.
		setPanelOrder(nextPanelOrder);
		return nextPanelOrder;
	}

	return panelOrder;
}

interface ApplicationTabProps {
	tab: ApplicationTabItem;
	order: readonly string[];
	tabDomId: string;
	panelDomId: string;
	isReorderable: boolean;
	isPrimary: boolean;
	isSplit: boolean;
	canSplit: boolean;
	canClose: boolean;
	onMove: (sourceKey: string, targetKey: string, position: DropPosition) => void;
	onRequestSplit: (key: string | null) => void;
	onRequestClose: (tab: ApplicationTabItem) => void;
}

function ApplicationTab({
	tab,
	order,
	tabDomId,
	panelDomId,
	isReorderable,
	isPrimary,
	isSplit,
	canSplit,
	canClose,
	onMove,
	onRequestSplit,
	onRequestClose,
}: ApplicationTabProps) {
	const ref = useRef<HTMLFieldSetElement>(null);
	const [dropPosition, setDropPosition] = useState<DropPosition>();
	const { dragProps, dragButtonProps, isDragging } = useDrag({
		hasDragButton: true,
		isDisabled: !isReorderable || tab.isDisabled,
		getItems: () => [
			{
				[APPLICATION_TAB_DRAG_TYPE]: tab.id,
				'text/plain': tab.label,
			},
		],
		getAllowedDropOperations: () => ['move'],
	});

	const positionForPoint = (x: number): DropPosition => {
		const width = ref.current?.getBoundingClientRect().width ?? 0;
		return x > width / 2 ? 'after' : 'before';
	};

	const { dropProps, isDropTarget } = useDrop({
		ref,
		isDisabled: !isReorderable || tab.isDisabled,
		getDropOperation: (types) => (types.has(APPLICATION_TAB_DRAG_TYPE) ? 'move' : 'cancel'),
		onDropEnter: (event) => setDropPosition(positionForPoint(event.x)),
		onDropMove: (event) => setDropPosition(positionForPoint(event.x)),
		onDropExit: () => setDropPosition(undefined),
		onDrop: (event) => {
			const position = positionForPoint(event.x);
			setDropPosition(undefined);
			const item = event.items.find(
				(candidate) => candidate.kind === 'text' && candidate.types.has(APPLICATION_TAB_DRAG_TYPE),
			);
			if (item?.kind !== 'text') return;
			void item.getText(APPLICATION_TAB_DRAG_TYPE).then((sourceKey) => {
				onMove(sourceKey, tab.id, position);
			});
		},
	});

	const moveWithKeyboard = (direction: -1 | 1) => {
		const currentIndex = order.indexOf(tab.id);
		const targetKey = order[currentIndex + direction];
		if (!targetKey) return;
		onMove(tab.id, targetKey, direction < 0 ? 'before' : 'after');
	};

	return (
		<Tab
			id={tab.id}
			isDisabled={tab.isDisabled}
			render={(domProps) => (
				<div
					{...(domProps as HTMLAttributes<HTMLDivElement>)}
					id={tabDomId}
					aria-controls={panelDomId}
				/>
			)}
			className={({ isSelected, isFocusVisible }) =>
				cn(
					'group relative flex h-9 min-w-28 max-w-56 shrink-0 cursor-default items-center gap-1.5 border-r border-border/70 px-2 text-xs outline-none transition-colors',
					isSelected
						? 'bg-background text-foreground before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-primary'
						: 'bg-muted/30 text-muted-foreground hover:bg-muted/60 hover:text-foreground',
					isSplit && !isSelected && 'bg-primary/5 text-foreground',
					isFocusVisible && 'inset-ring-2 inset-ring-ring',
					isDragging && 'opacity-50',
				)
			}
		>
			<fieldset
				{...dragProps}
				{...dropProps}
				ref={ref}
				tabIndex={isReorderable && !tab.isDisabled ? -1 : undefined}
				aria-label={`Drop ${tab.label} tab here`}
				className="flex min-w-0 flex-1 items-center gap-1.5 border-0 p-0"
			>
				{isReorderable ? (
					<Button
						{...dragButtonProps}
						aria-label={`Reorder ${tab.label}`}
						onKeyDown={(event) => {
							if (!event.altKey || !event.shiftKey) return;
							if (event.key === 'ArrowLeft') moveWithKeyboard(-1);
							else if (event.key === 'ArrowRight') moveWithKeyboard(1);
							else return;
							event.preventDefault();
						}}
						className="-ml-1 flex size-5 shrink-0 cursor-grab items-center justify-center rounded-sm text-muted-foreground/70 opacity-0 outline-none hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring group-hover:opacity-100 pressed:cursor-grabbing"
					>
						<GripVertical className="size-3" />
					</Button>
				) : null}
				<span className="shrink-0 text-muted-foreground [&>svg]:size-3.5">{tab.icon}</span>
				<span className="min-w-0 flex-1 truncate">{tab.label}</span>
				{isSplit ? (
					<Button
						aria-label={`Close ${tab.label} split view`}
						className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 outline-none hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring group-hover:opacity-100"
						onPress={() => onRequestSplit(null)}
					>
						<PanelRightClose className="size-3.5" />
					</Button>
				) : canSplit && !isPrimary ? (
					<Button
						aria-label={`Open ${tab.label} to the side`}
						className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 outline-none hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring group-hover:opacity-100"
						onPress={() => onRequestSplit(tab.id)}
					>
						<PanelRightOpen className="size-3.5" />
					</Button>
				) : null}
				{tab.browserUrl ? (
					<Button
						aria-label={`Open ${tab.label} in a new browser tab`}
						className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 outline-none hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring group-hover:opacity-100"
						onPress={() => {
							const opened = window.open(tab.browserUrl, '_blank', 'noopener,noreferrer');
							if (opened) opened.opener = null;
						}}
					>
						<ExternalLink className="size-3" />
					</Button>
				) : null}
				{tab.close && canClose ? (
					<Button
						aria-label={`Close ${tab.label}`}
						className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 outline-none hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring group-hover:opacity-100 group-data-[selected]:opacity-100"
						onPress={() => onRequestClose(tab)}
					>
						<X className="size-3.5" />
					</Button>
				) : null}
				{isDropTarget && dropPosition ? (
					<span
						aria-hidden="true"
						className={cn(
							'pointer-events-none absolute inset-y-1 z-10 w-0.5 rounded-full bg-primary',
							dropPosition === 'before' ? '-left-px' : '-right-px',
						)}
					/>
				) : null}
			</fieldset>
		</Tab>
	);
}

interface SplitResizeHandleProps {
	containerRef: RefObject<HTMLDivElement | null>;
	size: number;
	onSizeChange: (size: number) => void;
}

function SplitResizeHandle({ containerRef, size, onSizeChange }: SplitResizeHandleProps) {
	const activePointerId = useRef<number | undefined>(undefined);

	const finishPointerResize = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (activePointerId.current !== event.pointerId) return;
		activePointerId.current = undefined;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
	};

	return (
		<div
			role="separator"
			aria-label="Resize split view"
			aria-orientation="vertical"
			aria-valuemin={MIN_SPLIT_SIZE}
			aria-valuemax={MAX_SPLIT_SIZE}
			aria-valuenow={Math.round(size)}
			aria-valuetext={`${Math.round(size)}% left pane`}
			tabIndex={0}
			className="relative col-start-2 row-start-1 z-10 flex w-1.5 touch-none cursor-col-resize select-none items-center justify-center border-0 outline-none before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-border before:transition-colors after:absolute after:left-1/2 after:h-6 after:w-1 after:-translate-x-1/2 after:rounded-full after:bg-muted-foreground/30 after:transition-colors hover:before:bg-primary hover:after:bg-primary focus-visible:before:bg-primary focus-visible:after:bg-primary"
			onDoubleClick={() => onSizeChange(DEFAULT_SPLIT_SIZE)}
			onKeyDown={(event) => {
				const step = event.shiftKey ? 10 : 2;
				let nextSize: number | undefined;
				if (event.key === 'ArrowLeft') nextSize = size - step;
				else if (event.key === 'ArrowRight') nextSize = size + step;
				else if (event.key === 'Home') nextSize = MIN_SPLIT_SIZE;
				else if (event.key === 'End') nextSize = MAX_SPLIT_SIZE;
				if (nextSize === undefined) return;
				event.preventDefault();
				onSizeChange(nextSize);
			}}
			onPointerDown={(event) => {
				activePointerId.current = event.pointerId;
				event.currentTarget.setPointerCapture(event.pointerId);
				event.preventDefault();
			}}
			onPointerMove={(event) => {
				if (activePointerId.current !== event.pointerId) return;
				const bounds = containerRef.current?.getBoundingClientRect();
				if (!bounds?.width) return;
				onSizeChange(((event.clientX - bounds.left) / bounds.width) * 100);
			}}
			onPointerUp={finishPointerResize}
			onPointerCancel={finishPointerResize}
		/>
	);
}

export function ApplicationTabs({
	ariaLabel,
	tabs,
	selectedKey,
	defaultSelectedKey,
	onSelectionChange,
	order,
	defaultOrder,
	onOrderChange,
	onClose,
	onCloseError,
	allowsSplitView = true,
	splitKey,
	defaultSplitKey,
	onSplitKeyChange,
	splitSize,
	defaultSplitSize = DEFAULT_SPLIT_SIZE,
	onSplitSizeChange,
	actions,
	className,
	tabListClassName,
	panelsClassName,
}: ApplicationTabsProps) {
	const instanceId = useId();
	const tabKeys = useMemo(() => tabs.map((tab) => tab.id), [tabs]);
	const tabsById = useMemo(() => new Map(tabs.map((tab) => [tab.id, tab])), [tabs]);
	const [internalSelectedKey, setInternalSelectedKey] = useState(
		() => defaultSelectedKey ?? tabKeys[0],
	);
	const [internalOrder, setInternalOrder] = useState(() =>
		reconcileOrder(defaultOrder ?? tabKeys, tabKeys),
	);
	const [internalSplitKey, setInternalSplitKey] = useState<string | null>(
		() => defaultSplitKey ?? null,
	);
	const [internalSplitSize, setInternalSplitSize] = useState(() =>
		clampSplitSize(defaultSplitSize),
	);
	const visibleOrder = reconcileOrder(order ?? internalOrder, tabKeys);
	const panelOrder = useStablePanelOrder(tabKeys);
	const requestedPrimaryKey = selectedKey ?? internalSelectedKey;
	const primaryKey = tabsById.has(requestedPrimaryKey) ? requestedPrimaryKey : tabKeys[0];
	const requestedSplitKey = splitKey === undefined ? internalSplitKey : splitKey;
	const splitTab = requestedSplitKey ? tabsById.get(requestedSplitKey) : undefined;
	const activeSplitKey =
		allowsSplitView &&
		!!splitTab &&
		requestedSplitKey !== primaryKey &&
		!splitTab.isDisabled &&
		splitTab.isSplittable !== false
			? requestedSplitKey
			: null;
	const activeSplitSize = clampSplitSize(splitSize ?? internalSplitSize);
	const hasSplit = activeSplitKey !== null;
	const panelsRef = useRef<HTMLDivElement>(null);
	const [closeKey, setCloseKey] = useState<string>();
	const [isClosePending, setIsClosePending] = useState(false);
	const closingTab = closeKey ? tabsById.get(closeKey) : undefined;
	const isReorderable = tabs.length > 1;

	const changeSplitKey = (nextKey: string | null) => {
		if (splitKey === undefined) setInternalSplitKey(nextKey);
		onSplitKeyChange?.(nextKey);
	};

	const changeSplitSize = (nextSize: number) => {
		const clampedSize = clampSplitSize(nextSize);
		if (clampedSize === activeSplitSize) return;
		if (splitSize === undefined) setInternalSplitSize(clampedSize);
		onSplitSizeChange?.(clampedSize);
	};

	const changeSelection = (nextKey: string) => {
		if (nextKey === activeSplitKey && primaryKey) changeSplitKey(primaryKey);
		if (selectedKey === undefined) setInternalSelectedKey(nextKey);
		onSelectionChange?.(nextKey);
	};

	const changeOrder = (sourceKey: string, targetKey: string, position: DropPosition) => {
		const next = moveKey(visibleOrder, sourceKey, targetKey, position);
		if (sameKeys(next, visibleOrder)) return;
		if (order === undefined) setInternalOrder(next);
		onOrderChange?.(next);
	};

	const confirmClose = async () => {
		if (!closingTab || !onClose) return;
		setIsClosePending(true);
		try {
			await onClose(closingTab);
			setCloseKey(undefined);
		} catch (error) {
			onCloseError?.(error, closingTab);
		} finally {
			setIsClosePending(false);
		}
	};

	return (
		<>
			<Tabs
				selectedKey={primaryKey}
				onSelectionChange={(key) => changeSelection(String(key))}
				keyboardActivation="automatic"
				className={cn('flex min-h-0 flex-1 flex-col bg-background', className)}
			>
				<div className="flex h-9 shrink-0 items-end border-b bg-muted/50">
					<TabList
						aria-label={ariaLabel}
						className={cn(
							'flex h-full min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
							tabListClassName,
						)}
					>
						{visibleOrder.map((key) => {
							const tab = tabsById.get(key);
							return tab ? (
								<ApplicationTab
									key={tab.id}
									tab={tab}
									order={visibleOrder}
									tabDomId={`${instanceId}-tab-${tab.id}`}
									panelDomId={`${instanceId}-panel-${tab.id}`}
									isReorderable={isReorderable}
									isPrimary={tab.id === primaryKey}
									isSplit={tab.id === activeSplitKey}
									canSplit={
										allowsSplitView &&
										tab.isSplittable !== false &&
										!tab.isDisabled &&
										tabs.length > 1
									}
									canClose={!!onClose}
									onMove={changeOrder}
									onRequestSplit={changeSplitKey}
									onRequestClose={(item) => setCloseKey(item.id)}
								/>
							) : null;
						})}
					</TabList>
					{actions ? (
						<div className="flex h-full shrink-0 items-center border-l px-1">{actions}</div>
					) : null}
				</div>
				<div
					ref={panelsRef}
					data-application-panels=""
					className={cn(
						'relative min-h-0 flex-1 overflow-hidden',
						hasSplit && 'grid grid-rows-[minmax(0,1fr)]',
						panelsClassName,
					)}
					style={
						hasSplit
							? {
									gridTemplateColumns: `${activeSplitSize}fr 0.375rem ${100 - activeSplitSize}fr`,
								}
							: undefined
					}
				>
					{panelOrder.map((key) => {
						const tab = tabsById.get(key);
						const isPrimary = key === primaryKey;
						const isSplit = key === activeSplitKey;
						const isVisible = isPrimary || isSplit;
						return tab ? (
							<div
								key={tab.id}
								id={`${instanceId}-panel-${tab.id}`}
								role="tabpanel"
								aria-labelledby={`${instanceId}-tab-${tab.id}`}
								aria-hidden={isVisible ? undefined : true}
								inert={isVisible ? undefined : true}
								className={cn(
									'min-h-0 min-w-0 overflow-hidden outline-none',
									!isVisible && 'hidden',
									isVisible && !hasSplit && 'absolute inset-0',
									isPrimary && hasSplit && 'col-start-1 row-start-1',
									isSplit && 'col-start-3 row-start-1',
									tab.panelClassName,
								)}
							>
								{tab.panel}
							</div>
						) : null;
					})}
					{hasSplit ? (
						<SplitResizeHandle
							containerRef={panelsRef}
							size={activeSplitSize}
							onSizeChange={changeSplitSize}
						/>
					) : null}
				</div>
			</Tabs>

			{closingTab?.close ? (
				<ConfirmDialog
					isOpen
					onClose={() => setCloseKey(undefined)}
					title={closingTab.close.title}
					description={closingTab.close.description}
					confirmLabel={closingTab.close.confirmLabel ?? 'Close'}
					pendingLabel={closingTab.close.pendingLabel ?? 'Closing...'}
					isPending={isClosePending}
					onConfirm={() => void confirmClose()}
				/>
			) : null}
		</>
	);
}
