import { shellQuote, withEnvPrefix } from './shell';

export class ShellEnvironment {
	private env: Record<string, string> = {};
	private defaults: Record<string, string> = {};
	private pending?: { content: string; path: Promise<string> };

	constructor(private readonly write: (path: string, content: string) => Promise<void>) {}

	invalidate(): void {
		this.pending = undefined;
	}

	setEnvVars(vars: Record<string, string>, options?: { onlyIfUnset?: boolean }): void {
		if (options?.onlyIfUnset) {
			this.defaults = { ...this.defaults, ...vars };
		} else {
			this.env = { ...this.env, ...vars };
		}
	}

	async command(
		command: string,
		overrides: Record<string, string> = {},
		defaults: Record<string, string> = this.defaults,
	): Promise<string> {
		const env = { ...this.env, ...overrides };
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
