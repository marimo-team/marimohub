import { shellQuote, withEnvPrefix } from './shell';

export class ShellEnvironment {
	private pending?: { content: string; path: Promise<string> };

	constructor(private readonly write: (path: string, content: string) => Promise<void>) {}

	async command(
		command: string,
		env: Record<string, string>,
		defaults: Record<string, string> = {},
	): Promise<string> {
		for (const name of [...Object.keys(env), ...Object.keys(defaults)]) {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Invalid environment name');
		}
		const content = withEnvPrefix('', env, defaults);
		if (!content) return command;
		// Immutable files keep concurrent commands from observing another command's env.
		if (this.pending?.content !== content) {
			const path = `/tmp/marimohub-env-${crypto.randomUUID()}/env.sh`;
			const pending = {
				content,
				path: this.write(path, content).then(() => path),
			};
			this.pending = pending;
			void pending.path.catch(() => {
				if (this.pending === pending) this.pending = undefined;
			});
		}
		return `. ${shellQuote(await this.pending.path)} || exit $?; ${command}`;
	}
}

export function privateEnvironmentWriteCommand(path: string): string {
	const directory = path.slice(0, path.lastIndexOf('/'));
	return `mkdir -m 700 ${shellQuote(directory)} && (umask 077; cat > ${shellQuote(path)})`;
}
