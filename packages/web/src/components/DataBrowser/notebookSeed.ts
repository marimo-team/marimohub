import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useCreateNotebook } from '@/api/hooks';

export function seededNotebookCode(heading: string, snippet: string): string {
	const cellBody = snippet
		.split('\n')
		.map((line) => (line === '' ? '' : `    ${line}`))
		.join('\n');
	return [
		'import marimo',
		'',
		'app = marimo.App(width="medium", sql_output="native")',
		'',
		'',
		'@app.cell',
		'def _():',
		'    import marimo as mo',
		'    return (mo,)',
		'',
		'',
		'@app.cell(hide_code=True)',
		'def _(mo):',
		`    mo.md(${JSON.stringify(`# ${heading}`)})`,
		'    return',
		'',
		'',
		'@app.cell',
		'def _():',
		cellBody,
		'    return',
		'',
		'',
		'if __name__ == "__main__":',
		'    app.run()',
		'',
	].join('\n');
}

export function useSeededNotebook(projectId: string) {
	const createNotebook = useCreateNotebook(projectId);
	const navigate = useNavigate();
	return {
		isPending: createNotebook.isPending,
		create: async ({
			title,
			heading,
			description,
			snippet,
		}: {
			title: string;
			heading: string;
			description: string;
			snippet: string;
		}) => {
			try {
				const created = await createNotebook.mutateAsync({
					title,
					description,
					code: seededNotebookCode(heading, snippet),
				});
				toast.success(`Created "${title}"`);
				void navigate(`/projects/${projectId}/notebooks/${created.id}`, { state: { title } });
			} catch {
				// Preserve the browser selection; the shared mutation handler reports the failure.
			}
		},
	};
}
