/**
 * marimo kernel template for the E2B compute backend (`@marimo-hub/compute-e2b`) —
 * E2B build system **v2** (SDK-defined; the old `e2b.toml` + `e2b.Dockerfile` were
 * v1 and are deprecated).
 *
 * Parallels examples/sandbox-image (the container-backend kernel image): uv + a
 * pinned marimo (`recommended,ai,sql`) + the warm libs in a reused /opt/venv, so
 * `uv run --no-sync marimo edit` resolves marimo even for a notebook with no
 * pyproject.toml. E2B injects its own `envd`; the compute adapter launches marimo
 * per session, so there is no start command.
 */
import { Template } from 'e2b';

// Pin marimo so rebuilds don't silently upgrade it (match your sandbox image).
const MARIMO_VERSION = '0.23.11';

export const template = Template()
	.fromImage('python:3.13-slim')
	// Run as root throughout: `python:3.13-slim` has no `user` account (E2B v2's
	// default), and /workspace is world-writable + /opt/venv world-readable, so the
	// kernel works whether E2B execs as root or a user it injects.
	.setUser('root')
	.aptInstall(['git', 'ca-certificates', 'curl', 'locales'])
	.runCmd("sed -i 's/^# *en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen && locale-gen")
	// uv on PATH. The v2 builder has no multi-stage `COPY --from`, so install uv via
	// pip (global) instead of copying it from the astral image.
	.pipInstall('uv==0.10.9')
	// BUILD-time env: `uv add` below must install into /opt/venv. E2B applies setEnvs
	// to build layers ONLY — for the RUNTIME env the kernel needs, see the
	// /etc/profile.d/marimo.sh copied in below.
	.setEnvs({
		UV_PROJECT_ENVIRONMENT: '/opt/venv',
		UV_CACHE_DIR: '/opt/uv-cache',
	})
	// Pre-install marimo (pinned) + the warm libs into /opt/venv so the base-case
	// kernel needs no install; warm/pyproject.toml is copied from the build dir.
	.copy('warm/pyproject.toml', '/tmp/base/pyproject.toml')
	.runCmd(
		`cd /tmp/base && uv venv --python 3.13 /opt/venv && uv add --compile-bytecode "marimo[recommended,ai,sql]==${MARIMO_VERSION}" && rm -rf /tmp/base`,
	)
	// The exec user must be able to write the notebook and snapshots in /workspace.
	.runCmd('mkdir -p /workspace && chmod -R 0777 /workspace')
	// Runtime env for the kernel's login shell (see files/marimo.sh). THE KEY GOTCHA:
	// E2B runs commands in a login shell that re-sources /etc/profile, so the build
	// env above never reaches the launch — `UV_PROJECT_ENVIRONMENT` etc. must live in
	// /etc/profile.d for `uv run --no-sync marimo` to resolve /opt/venv.
	.copy('files/marimo.sh', '/etc/profile.d/marimo.sh')
	.setWorkdir('/workspace');
