import { describe, expect, it } from 'vitest';
import type {
	NotebookId,
	ProjectId,
	ProposalId,
	SessionId,
	SnapshotId,
	UserId,
	VersionId,
} from './ids';
import { paths } from './paths';

const pid = 'proj_01HXY11111ABCDEFGHJKMN' as ProjectId;
const nid = 'nb_01HXYZ22222PQRSTUVWXYZ' as NotebookId;
const vid = 'ver_01HXYZ33333RSTUVWXYZAB' as VersionId;
const sid = 'snap_01HXYZ9ABCDEFGHJKMNPQ' as SnapshotId;
const sessId = 'sess_01HXYZ44444CDEFGHJKMNP' as SessionId;
const proposalId = 'prop-0123456789abcdef' as ProposalId;

describe('paths', () => {
	it('system paths', () => {
		expect(paths.catalog).toMatchInlineSnapshot(`"_system/catalog.json"`);
		expect(paths.sessionsPrefix).toMatchInlineSnapshot(`"_system/sessions/"`);
		expect(paths.snapshot(sid)).toMatchInlineSnapshot(
			`"_system/snapshots/snap_01HXYZ9ABCDEFGHJKMNPQ.json"`,
		);
		expect(paths.session(pid, sessId)).toMatchInlineSnapshot(
			`"_system/sessions/proj_01HXY11111ABCDEFGHJKMN/sess_01HXYZ44444CDEFGHJKMNP.json"`,
		);
		expect(paths.sessionsForProject(pid)).toMatchInlineSnapshot(
			`"_system/sessions/proj_01HXY11111ABCDEFGHJKMN/"`,
		);
		expect(paths.eventsForDate('2025-03-05')).toMatchInlineSnapshot(`"_system/events/2025-03-05/"`);
		expect(paths.event('2025-03-05', '01HXYZ9ABCDEFGHJKMNPQRSTVW')).toMatchInlineSnapshot(
			`"_system/events/2025-03-05/01HXYZ9ABCDEFGHJKMNPQRSTVW.json"`,
		);
	});

	it('project paths', () => {
		const proj = paths.project(pid);
		expect(proj.meta).toMatchInlineSnapshot(`"projects/proj_01HXY11111ABCDEFGHJKMN/project.json"`);
	});

	it('notebook paths', () => {
		const nb = paths.project(pid).notebook(nid);
		expect(nb).toMatchInlineSnapshot(`
			{
			  "base": "projects/proj_01HXY11111ABCDEFGHJKMN/notebooks/nb_01HXYZ22222PQRSTUVWXYZ",
			  "code": "projects/proj_01HXY11111ABCDEFGHJKMN/notebooks/nb_01HXYZ22222PQRSTUVWXYZ/workspace/notebook.py",
			  "deps": "projects/proj_01HXY11111ABCDEFGHJKMN/notebooks/nb_01HXYZ22222PQRSTUVWXYZ/workspace/pyproject.toml",
			  "fsSnapshot": "projects/proj_01HXY11111ABCDEFGHJKMN/notebooks/nb_01HXYZ22222PQRSTUVWXYZ/fs_snapshot.json",
			  "integrationSyncToken": "projects/proj_01HXY11111ABCDEFGHJKMN/notebooks/nb_01HXYZ22222PQRSTUVWXYZ/integration_sync_token.json",
			  "job": [Function],
			  "jobsPrefix": "projects/proj_01HXY11111ABCDEFGHJKMN/notebooks/nb_01HXYZ22222PQRSTUVWXYZ/jobs/",
			  "meta": "projects/proj_01HXY11111ABCDEFGHJKMN/notebooks/nb_01HXYZ22222PQRSTUVWXYZ/meta.json",
			  "proposal": [Function],
			  "readme": "projects/proj_01HXY11111ABCDEFGHJKMN/notebooks/nb_01HXYZ22222PQRSTUVWXYZ/README.md",
			  "source": "projects/proj_01HXY11111ABCDEFGHJKMN/notebooks/nb_01HXYZ22222PQRSTUVWXYZ/source.json",
			  "version": [Function],
			  "workspaceFile": [Function],
			  "workspaceMutationClaim": "projects/proj_01HXY11111ABCDEFGHJKMN/notebooks/nb_01HXYZ22222PQRSTUVWXYZ/workspace_mutation_claim.json",
			  "workspacePrefix": "projects/proj_01HXY11111ABCDEFGHJKMN/notebooks/nb_01HXYZ22222PQRSTUVWXYZ/workspace/",
			}
		`);
	});

	it('proposal paths', () => {
		const proposal = paths.project(pid).notebook(nid).proposal(proposalId);
		expect(proposal.meta).toBe(
			'projects/proj_01HXY11111ABCDEFGHJKMN/notebooks/nb_01HXYZ22222PQRSTUVWXYZ/proposals/prop-0123456789abcdef/proposal.json',
		);
		expect(proposal.publication).toBe(
			'projects/proj_01HXY11111ABCDEFGHJKMN/notebooks/nb_01HXYZ22222PQRSTUVWXYZ/proposals/prop-0123456789abcdef/publication.json',
		);
		expect(proposal.change(2)).toBe(
			'projects/proj_01HXY11111ABCDEFGHJKMN/notebooks/nb_01HXYZ22222PQRSTUVWXYZ/proposals/prop-0123456789abcdef/changes/2',
		);
		expect(paths.proposalPayloadMarker(pid, nid, proposalId)).toBe(
			'_system/proposal-payloads/proj_01HXY11111ABCDEFGHJKMN/nb_01HXYZ22222PQRSTUVWXYZ/prop-0123456789abcdef.json',
		);
	});

	it('version paths', () => {
		const ver = paths.project(pid).notebook(nid).version(vid);
		expect(ver).toMatchInlineSnapshot(`
			{
			  "code": "projects/proj_01HXY11111ABCDEFGHJKMN/notebooks/nb_01HXYZ22222PQRSTUVWXYZ/versions/ver_01HXYZ33333RSTUVWXYZAB/notebook.py",
			  "deps": "projects/proj_01HXY11111ABCDEFGHJKMN/notebooks/nb_01HXYZ22222PQRSTUVWXYZ/versions/ver_01HXYZ33333RSTUVWXYZAB/pyproject.toml",
			  "gitFile": [Function],
			  "gitPrefix": "projects/proj_01HXY11111ABCDEFGHJKMN/notebooks/nb_01HXYZ22222PQRSTUVWXYZ/versions/ver_01HXYZ33333RSTUVWXYZAB/git/",
			  "html": "projects/proj_01HXY11111ABCDEFGHJKMN/notebooks/nb_01HXYZ22222PQRSTUVWXYZ/versions/ver_01HXYZ33333RSTUVWXYZAB/notebook.html",
			  "meta": "projects/proj_01HXY11111ABCDEFGHJKMN/notebooks/nb_01HXYZ22222PQRSTUVWXYZ/versions/ver_01HXYZ33333RSTUVWXYZAB/version.json",
			  "session": "projects/proj_01HXY11111ABCDEFGHJKMN/notebooks/nb_01HXYZ22222PQRSTUVWXYZ/versions/ver_01HXYZ33333RSTUVWXYZAB/session.json",
			  "workspaceArchive": "projects/proj_01HXY11111ABCDEFGHJKMN/notebooks/nb_01HXYZ22222PQRSTUVWXYZ/versions/ver_01HXYZ33333RSTUVWXYZAB/workspace.zip",
			  "workspaceFile": [Function],
			  "workspacePrefix": "projects/proj_01HXY11111ABCDEFGHJKMN/notebooks/nb_01HXYZ22222PQRSTUVWXYZ/versions/ver_01HXYZ33333RSTUVWXYZAB/workspace/",
			}
		`);
	});

	it('identity() encodes a user id so a "/" or ".." segment cannot escape the identities prefix', () => {
		const key = paths.identity('../../evil' as UserId);
		expect(key.startsWith(paths.identitiesPrefix)).toBe(true);
		expect(key.slice(paths.identitiesPrefix.length)).not.toContain('/');
	});

	it('sandboxDiagnosticLease() encodes the user id within its prefix', () => {
		const key = paths.sandboxDiagnosticLease('../../evil' as UserId);
		expect(key.startsWith(paths.sandboxDiagnosticLeasesPrefix)).toBe(true);
		expect(key.slice(paths.sandboxDiagnosticLeasesPrefix.length)).not.toContain('/');
	});

	it('composability — intermediate objects are reusable', () => {
		const proj = paths.project(pid);
		const nb1 = proj.notebook('nb_01AAAA00000000000000000000' as NotebookId);
		const nb2 = proj.notebook('nb_01BBBB00000000000000000000' as NotebookId);

		expect(nb1.code).not.toBe(nb2.code);
		expect(nb1.code).toContain('nb_01AAAA');
		expect(nb2.code).toContain('nb_01BBBB');

		const v1 = nb1.version('ver_01AAAA00000000000000000000' as VersionId);
		const v2 = nb1.version('ver_01BBBB00000000000000000000' as VersionId);
		expect(v1.code).not.toBe(v2.code);
	});
});
