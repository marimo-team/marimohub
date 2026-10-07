from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SOURCE = Path(__file__).resolve().parent


class PairInstallerTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.skill = Path(directory.name) / "marimo-pair"
        self.scripts = self.skill / "scripts"
        self.scripts.mkdir(parents=True)
        self.upstream = "#!/usr/bin/env bash\nprintf 'upstream\\n'\n"
        for name in ("execute-code", "discover-servers"):
            script = self.scripts / f"{name}.sh"
            script.write_text(self.upstream)
            script.chmod(0o755)
        self.frontmatter = "---\nname: marimo-pair\ndescription: Pair with marimo\n---\n"

    def install(self, examples):
        self.instructions = self.frontmatter + examples
        self.skill.joinpath("SKILL.md").write_text(self.instructions)
        return subprocess.run(
            [sys.executable, str(SOURCE / "install-marimo-pair.py"),
             str(self.skill), str(SOURCE / "marimo-pair")],
            capture_output=True, text=True, timeout=10,
        )

    def test_installs_wrappers_and_rewrites_all_url_examples(self):
        result = self.install("--url http://localhost:2718\n--url http://localhost:2718 -c 'code'\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        instructions = self.skill.joinpath("SKILL.md").read_text()
        self.assertTrue(instructions.startswith(self.frontmatter))
        self.assertEqual(instructions.count('--url "${MARIMOHUB_KERNEL_URL:-http://localhost:2718}"'), 2)
        self.assertIn("bash /home/appuser/.agents/skills/marimo-pair/scripts/execute-code.sh", instructions)
        self.assertNotIn("/absolute/path/to/", instructions)
        for name in ("execute-code", "discover-servers"):
            script = self.scripts / f"{name}.sh"
            self.assertEqual(script.read_text(), SOURCE.joinpath("marimo-pair", script.name).read_text())
            self.assertEqual(script.stat().st_mode & 0o777, 0o755)
            self.assertEqual(self.scripts.joinpath(f"{name}-upstream.sh").read_text(), self.upstream)

    def test_upstream_drift_fails_before_modifying_the_skill(self):
        for example in (
            '--url "http://localhost:2718"',
            "--url\n  http://localhost:2718",
            "--url http://localhost:9999",
            "No URL example remains.",
        ):
            with self.subTest(example=example):
                result = self.install(example)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("expected kernel URL example", result.stderr)
                self.assertEqual(self.skill.joinpath("SKILL.md").read_text(), self.instructions)
                self.assertEqual(sorted(path.name for path in self.scripts.iterdir()),
                                 ["discover-servers.sh", "execute-code.sh"])
                for script in self.scripts.iterdir():
                    self.assertEqual(script.read_text(), self.upstream)


if __name__ == "__main__":
    unittest.main()
