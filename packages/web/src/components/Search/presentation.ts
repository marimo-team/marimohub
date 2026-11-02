import {
	BookOpen,
	Braces,
	Database,
	Layers,
	MessageSquare,
	Columns3,
	Table2,
	Text,
} from 'lucide-react';
import type { SearchKind } from '@/api/search';

export const searchKinds = {
	notebook: { label: 'Notebooks', singular: 'Notebook', icon: BookOpen },
	code: { label: 'Code', singular: 'Code', icon: Braces },
	output: { label: 'Outputs', singular: 'Output', icon: Text },
	datasource: { label: 'Data sources', singular: 'Data source', icon: Database },
	namespace: { label: 'Namespaces', singular: 'Namespace', icon: Layers },
	table: { label: 'Tables', singular: 'Table', icon: Table2 },
	column: { label: 'Columns', singular: 'Column', icon: Columns3 },
	chat: { label: 'Chats', singular: 'Chat', icon: MessageSquare },
} satisfies Record<SearchKind, unknown>;
