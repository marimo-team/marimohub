import { ComboBox } from '@/components/ui/ComboBox';
import { useSourceBranchesQuery, useSourceCommitsQuery } from '@/api/sourceControl';

export function SourceRefInput({
	pid,
	nid,
	type,
	value,
	onChange,
}: {
	pid: string;
	nid: string;
	type: 'branch' | 'commit';
	value: string;
	onChange: (value: string) => void;
}) {
	const branches = useSourceBranchesQuery({ pid, nid, query: value, enabled: type === 'branch' });
	const commits = useSourceCommitsQuery({ pid, nid, query: value, enabled: type === 'commit' });
	const query = type === 'branch' ? branches : commits;
	const status = query.isFetching
		? 'Searching GitHub…'
		: query.isError
			? 'Suggestions are unavailable. You can still enter a value.'
			: type === 'branch'
				? 'No suggestions. Enter a branch name.'
				: 'No suggestions. Enter a full commit SHA.';
	return (
		<div className="space-y-2">
			<ComboBox
				retainSelection
				label={type === 'branch' ? 'Branch' : 'Commit SHA'}
				inputValue={value}
				onInputChange={onChange}
				onSelect={onChange}
				options={(query.data ?? []).map((item) => ({
					...item,
					id: item.value,
					textValue: item.value,
				}))}
				renderOption={(item) => (
					<span>
						{item.label}
						<span className="ml-2 text-muted-foreground"> · {item.commit.slice(0, 8)}</span>
					</span>
				)}
				emptyState={status}
			/>
			<p className="text-xs text-muted-foreground">
				Suggestions cover up to 100 branches or recent commits. You can enter another value.
			</p>
			<output className="text-xs text-muted-foreground">
				{query.isFetching || query.isError ? status : ''}
			</output>
		</div>
	);
}
