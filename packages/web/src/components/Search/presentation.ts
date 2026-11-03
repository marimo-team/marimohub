import type { LucideIcon } from 'lucide-react';
import { BookOpen, Braces, Columns3, Database, Layers, Search, Table2, Text } from 'lucide-react';
import type { SearchKind } from '@/api/search';

interface SearchKindPresentation {
	label: string;
	singular: string;
	icon: LucideIcon;
}

const searchKinds: Partial<Record<SearchKind, SearchKindPresentation>> = {
	notebook: { label: 'Notebooks', singular: 'Notebook', icon: BookOpen },
	code: { label: 'Code', singular: 'Code', icon: Braces },
	output: { label: 'Outputs', singular: 'Output', icon: Text },
	datasource: { label: 'Data sources', singular: 'Data source', icon: Database },
	namespace: { label: 'Namespaces', singular: 'Namespace', icon: Layers },
	table: { label: 'Tables', singular: 'Table', icon: Table2 },
	column: { label: 'Columns', singular: 'Column', icon: Columns3 },
};

// A newer server may return kinds this client does not know yet.
export function searchKind(kind: string): SearchKindPresentation {
	return (
		(Object.hasOwn(searchKinds, kind) ? searchKinds[kind as SearchKind] : undefined) ?? {
			label: kind,
			singular: kind,
			icon: Search,
		}
	);
}
