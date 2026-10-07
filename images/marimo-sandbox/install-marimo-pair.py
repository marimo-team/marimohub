from pathlib import Path
import shutil
import sys


skill = Path(sys.argv[1])
overlay = Path(sys.argv[2])
instructions = skill.joinpath("SKILL.md").read_text()
url_example = "--url http://localhost:2718"
if url_example not in instructions:
    raise ValueError("marimo-pair SKILL.md no longer contains the expected kernel URL example")
instructions = instructions.replace(
    url_example, '--url "${MARIMOHUB_KERNEL_URL:-http://localhost:2718}"'
)
frontmatter, body = instructions[4:].split("\n---", 1)
skill.joinpath("SKILL.md").write_text(
    "---\n" + frontmatter + "\n---\n\n" + overlay.joinpath("hub.md").read_text() + body
)
for name in ("execute-code", "discover-servers"):
    script = skill / "scripts" / f"{name}.sh"
    upstream = script.with_name(f"{name}-upstream.sh")
    script.rename(upstream)
    shutil.copyfile(overlay / f"{name}.sh", script)
    shutil.copymode(upstream, script)
