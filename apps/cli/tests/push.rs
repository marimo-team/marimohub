use assert_cmd::cargo::cargo_bin_cmd;
use predicates::prelude::*;

fn command(directory: &std::path::Path) -> assert_cmd::Command {
    let mut command = cargo_bin_cmd!("mohub");
    command
        .current_dir(directory)
        .env_remove("MARIMOHUB_TOKEN")
        .env("MARIMOHUB_NO_UPDATE_CHECK", "true")
        .env("MARIMOHUB_SYNC_TOKEN", "mhsync_never_print_this")
        .args([
            "--output",
            "json",
            "notebooks",
            "push",
            "--pid",
            "proj-test",
            "--nid",
            "nb-test",
            "--repo",
            "org/repo",
            "--branch",
            "main",
            "--commit",
            "abc123",
        ]);
    command
}

#[test]
fn dry_run_is_offline_and_never_prints_sync_credentials() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("app.py"), "print(1)").unwrap();
    command(dir.path())
        .arg("--dry-run")
        .assert()
        .success()
        .stdout(predicate::str::contains("app.py"))
        .stdout(predicate::str::contains("abc123"))
        .stdout(predicate::str::contains("mhsync_never_print_this").not());
    command(dir.path())
        .args(["--token", "unsafe", "--dry-run"])
        .assert()
        .failure()
        .stderr(predicate::str::contains(
            "only accepts MARIMOHUB_SYNC_TOKEN",
        ));
    command(dir.path())
        .args(["--sync-token", "unsafe"])
        .assert()
        .failure();
}

#[test]
fn rejects_oversized_files_before_upload() {
    let dir = tempfile::tempdir().unwrap();
    let file = std::fs::File::create(dir.path().join("large.bin")).unwrap();
    file.set_len(25 * 1024 * 1024 + 1).unwrap();
    command(dir.path())
        .arg("--dry-run")
        .assert()
        .failure()
        .stderr(predicate::str::contains("workspace exceeds limits"));
}

#[test]
fn refuses_subtree_git_and_parent_traversal() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("apps")).unwrap();
    command(dir.path())
        .args(["--root-path", "apps", "--include-git", "--dry-run"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("include-git requires"));
    command(dir.path())
        .args(["--root-path", "../", "--dry-run"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("root-path must be relative"));
}

#[test]
fn bulk_dry_run_supports_distinct_projects_and_rejects_duplicate_targets() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("app.py"), "print(1)").unwrap();
    let manifest = dir.path().join("apps.json");
    let app = |pid: &str, nid: &str| serde_json::json!({"path": "", "pid": pid, "nid": nid, "secret": "UNSET_SYNC_TEST"});
    std::fs::write(
        &manifest,
        serde_json::to_vec(&vec![
            app("project1", "notebook1"),
            app("project2", "notebook2"),
        ])
        .unwrap(),
    )
    .unwrap();
    let bulk = || {
        let mut cmd = cargo_bin_cmd!("mohub");
        cmd.current_dir(dir.path())
            .env_remove("UNSET_SYNC_TEST")
            .env("MARIMOHUB_NO_UPDATE_CHECK", "true")
            .args(["--output", "json", "notebooks", "push", "--manifest"])
            .arg(&manifest)
            .args([
                "--repo", "org/repo", "--branch", "main", "--commit", "abc123",
            ]);
        cmd
    };
    bulk()
        .arg("--dry-run")
        .assert()
        .success()
        .stdout(predicate::str::contains("project1"))
        .stdout(predicate::str::contains("project2"));
    bulk()
        .assert()
        .failure()
        .stderr(predicate::str::contains("set UNSET_SYNC_TEST"));
    std::fs::write(
        &manifest,
        serde_json::to_vec(&vec![
            app("project1", "notebook1"),
            app("project1", "notebook1"),
        ])
        .unwrap(),
    )
    .unwrap();
    bulk()
        .arg("--dry-run")
        .assert()
        .failure()
        .stderr(predicate::str::contains("duplicate"));
}
