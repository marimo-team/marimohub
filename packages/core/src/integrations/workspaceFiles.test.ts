import { describe, expect, it } from 'vitest';
import { BadRequestError } from '../errors';
import {
	normalizeWorkspaceDirectoryInput,
	normalizeWorkspacePathInput,
	workspaceMimeType,
	workspacePathName,
} from './workspaceFiles';

describe('workspace file helpers', () => {
	it.each([
		['/data/cars.csv', 'data/cars.csv'],
		['data/cars.csv', 'data/cars.csv'],
	])('normalizes a browser file path %s', (input, expected) => {
		expect(normalizeWorkspacePathInput(input)).toBe(expected);
	});

	it.each([
		['', ''],
		['/', ''],
		['/data/', 'data'],
		['data', 'data'],
	])('normalizes a browser directory path %s', (input, expected) => {
		expect(normalizeWorkspaceDirectoryInput(input)).toBe(expected);
	});

	it.each([
		'/../secret',
		'data/../secret',
		'/data//file.txt',
		'\\secret',
		'//server/share',
		'/data/file\nname.txt',
		'/data/file\u007fname.txt',
	])('rejects %s', (path) => {
		expect(() => normalizeWorkspacePathInput(path)).toThrow(BadRequestError);
	});

	it.each(['/data/../', '/data//nested', '//data'])('rejects unsafe directory %s', (path) => {
		expect(() => normalizeWorkspaceDirectoryInput(path)).toThrow(BadRequestError);
	});

	it('extracts names and infers case-insensitive MIME types', () => {
		expect(workspacePathName('assets/chart.PNG')).toBe('chart.PNG');
		expect(workspaceMimeType('assets/chart.PNG')).toBe('image/png');
		expect(workspaceMimeType('notebook.py')).toBe('text/x-python');
		expect(workspaceMimeType('archive.unknown')).toBe('application/octet-stream');
	});
});
