import { describe, expect, it } from 'vitest';
import { resolveSessionLinks, SessionLinkTemplatesSchema } from './sessionLinks';

const link = {
	id: 'lookout',
	label: 'Lookout',
	href_template: 'https://lookout.example/?jobSet={sandbox_id}',
};
const context = {
	sandbox_id: 'sb-123',
	session_id: 'sess-123',
	project_id: 'proj-123',
	notebook_id: 'nb-123',
};

describe('session link templates', () => {
	it.each([
		link.href_template,
		'http://lookout.internal:8080/jobs/{sandbox_id}',
		'https://grafana.example/d/kernel?project={project_id}&notebook={notebook_id}#session={session_id}',
		'https://console.example/jobs',
		'https://[::1]:8443/jobs/{sandbox_id}',
		'HTTPS://lookout.example/jobs/{sandbox_id}',
		'https://lookout.example/jobs/{sandbox_id}?filter=%7B%22team%22%3A%22data%22%7D',
	])('accepts %s', (href_template) => {
		expect(SessionLinkTemplatesSchema.parse([{ ...link, href_template }])).toHaveLength(1);
	});

	it.each([
		'javascript:alert(1)',
		'data:text/html,hello',
		'file:///tmp/{sandbox_id}',
		'//lookout.example/{sandbox_id}',
		'/jobs/{sandbox_id}',
		'https:lookout.example/{sandbox_id}',
		'https:///lookout.example/{sandbox_id}',
		'https://user:password@lookout.example/{sandbox_id}',
		'https://user@lookout.example/{sandbox_id}',
		'https://lookout.example:65536/{sandbox_id}',
		'https://%7Bsandbox_id%7D.example/jobs',
		'https://%7bjob_id%7d.example/jobs',
		'https://{sandbox_id}.example/jobs',
		'https://lookout.example:{sandbox_id}/jobs',
		'{sandbox_id}://lookout.example/jobs',
		'https://lookout.example/?job={job_id}',
		'https://lookout.example/?job={sandbox_id',
		'https://lookout.example/?job={{sandbox_id}}',
		'https://lookout.example/?job=sandbox_id}',
		'https://lookout.example/\n{sandbox_id}',
		'https://lookout.example/\u0000{sandbox_id}',
		'https://lookout.example/\u007f{sandbox_id}',
		'https://lookout.example/\u0085{sandbox_id}',
		'https://lookout.example\\@other.example/{sandbox_id}',
		`https://lookout.example/${'x'.repeat(2048)}`,
	])('rejects unsafe or unsupported template %j', (href_template) => {
		expect(SessionLinkTemplatesSchema.safeParse([{ ...link, href_template }]).success).toBe(false);
	});

	it('normalizes whitespace before checking ID uniqueness', () => {
		const padded = {
			id: ' lookout ',
			label: ' Lookout ',
			href_template: ` ${link.href_template} `,
		};
		expect(SessionLinkTemplatesSchema.parse([padded])).toEqual([link]);
		expect(SessionLinkTemplatesSchema.safeParse([link, padded]).success).toBe(false);
	});

	it('accepts exact field and list limits and an empty configuration', () => {
		const templates = Array.from({ length: 12 }, (_, index) => ({
			id: String(index).padStart(64, 'x'),
			label: 'x'.repeat(40),
			href_template: 'https://console.example/'.padEnd(2048, 'x'),
		}));
		expect(SessionLinkTemplatesSchema.parse(templates)).toEqual(templates);
		expect(resolveSessionLinks(SessionLinkTemplatesSchema.parse([]), context)).toEqual([]);
	});

	it('preserves static escapes and URL-encodes Unicode and percent signs exactly once', () => {
		const templates = [
			{ ...link, href_template: 'https://logs.example/{sandbox_id}?filter=hello%20world#日本語' },
		];
		const source = { ...context, sandbox_id: '日本語/%2F &☃' };
		const resolved = resolveSessionLinks(templates, source);
		expect(resolved[0].href).toBe(
			'https://logs.example/%E6%97%A5%E6%9C%AC%E8%AA%9E%2F%252F%20%26%E2%98%83?filter=hello%20world#日本語',
		);
		expect(resolveSessionLinks(templates, source)).toEqual(resolved);
		expect(templates[0].href_template).toContain('{sandbox_id}');
	});

	it('rejects duplicate IDs, oversized lists, and invalid fields', () => {
		for (const input of [
			[link, link],
			Array.from({ length: 13 }, (_, index) => ({ ...link, id: `link-${index}` })),
			[{ ...link, id: '' }],
			[{ ...link, id: 'a b' }],
			[{ ...link, id: 'a'.repeat(65) }],
			[{ ...link, label: ' ' }],
			[{ ...link, label: 'a'.repeat(41) }],
			[{ ...link, roles: ['admin'] }],
		]) {
			expect(SessionLinkTemplatesSchema.safeParse(input).success).toBe(false);
		}
	});

	it('encodes every occurrence without interpreting replacement text as another placeholder', () => {
		const templates = SessionLinkTemplatesSchema.parse([
			{
				...link,
				href_template:
					'https://lookout.example/{sandbox_id}?again={sandbox_id}&project={project_id}&notebook={notebook_id}#session={session_id}',
			},
		]);
		const links = resolveSessionLinks(templates, {
			...context,
			sandbox_id: 'job/a?b=c&d# {session_id}',
		});
		expect(links).toEqual([
			{
				id: 'lookout',
				label: 'Lookout',
				href: 'https://lookout.example/job%2Fa%3Fb%3Dc%26d%23%20%7Bsession_id%7D?again=job%2Fa%3Fb%3Dc%26d%23%20%7Bsession_id%7D&project=proj-123&notebook=nb-123#session=sess-123',
			},
		]);
	});

	it('omits only links whose required identifiers are missing', () => {
		const templates = [
			link,
			{ id: 'session', label: 'Session logs', href_template: 'https://logs.example/{session_id}' },
		];
		expect(resolveSessionLinks(templates, { ...context, sandbox_id: undefined })).toEqual([
			{ id: 'session', label: 'Session logs', href: 'https://logs.example/sess-123' },
		]);
		expect(resolveSessionLinks(templates, context).map((item) => item.id)).toEqual([
			'lookout',
			'session',
		]);
	});
});
