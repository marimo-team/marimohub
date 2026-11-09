import type { PreviewAutomationPolicy } from '@marimo-hub/core/preview-policy';

export type PreviewWorkflowOptions = PreviewAutomationPolicy & {
	hubUrl: string;
	projectId: string;
	notebookId: string;
};

export const PREVIEW_ACTION_REF = 'a3dd178fde69fe04611882c0c5b2c753e2125cd1';

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

export function previewWorkflow(options: PreviewWorkflowOptions): string {
	return `name: Notebook previews
on:
  pull_request:
    types: [opened, reopened, synchronize, closed]
permissions:
  actions: read
  pull-requests: write
concurrency:
  group: marimo-preview-\${{ github.event.pull_request.number }}
  queue: max
  cancel-in-progress: false
jobs:
  preview:
    if: github.event.pull_request.head.repo.full_name == github.repository && github.actor != 'dependabot[bot]'
    runs-on: ubuntu-latest
    steps:
      - uses: marimo-team/marimohub/actions/preview@${PREVIEW_ACTION_REF} # preview Action
        with:
          hub-url: ${quote(options.hubUrl)}
          project-id: ${quote(options.projectId)}
          notebook-id: ${quote(options.notebookId)}
          hub-token: \${{ secrets.MARIMOHUB_TOKEN }}
          mode: ${options.mode}
          keep: '${options.keep}'
          eager: '${options.eager}'
${options.idle_days ? `          idle-days: '${options.idle_days}'\n` : ''}`;
}
