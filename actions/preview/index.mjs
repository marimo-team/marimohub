import { appendFile, readFile } from 'node:fs/promises';
import { runPreview } from './preview.mjs';

const input = (key) => process.env[`INPUT_${key.toUpperCase()}`] ?? '';
const escape = (value) =>
	String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
for (const secret of [input('hub-token'), input('github-token')]) {
	if (secret) process.stdout.write(`::add-mask::${escape(secret)}\n`);
}
try {
	await runPreview({
		input,
		event: JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')),
		env: process.env,
		summary: (text) => appendFile(process.env.GITHUB_STEP_SUMMARY, text),
		output: (name, value) => appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`),
		warning: (message) => process.stdout.write(`::warning::${escape(message)}\n`),
	});
} catch (error) {
	process.stdout.write(`::error::${escape(error.message)}\n`);
	process.exitCode = 1;
}
