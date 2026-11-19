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

#[test]
fn subtree_and_manifest_apply_checkout_ignore_rules_with_relative_paths() {
    let parent = tempfile::tempdir().unwrap();
    std::fs::write(parent.path().join(".marimohubignore"), "keep.py\n").unwrap();
    let checkout = parent.path().join("repo");
    let subtree = checkout.join("apps/nested");
    std::fs::create_dir_all(subtree.join(".secrets")).unwrap();
    assert!(std::process::Command::new("git")
        .args(["init", "--quiet"])
        .arg(&checkout)
        .status()
        .unwrap()
        .success());
    std::fs::write(
        checkout.join(".marimohubignore"),
        ".env\n/apps/nested/blocked.py\n/root-only.py\n*.tmp\n.secrets/\n",
    )
    .unwrap();
    std::fs::write(
        checkout.join("apps/.marimohubignore"),
        "/nested/local.py\n!restored.tmp\n",
    )
    .unwrap();
    std::fs::write(subtree.join(".marimohubignore"), "!allowed.tmp\n").unwrap();
    for path in [
        ".env",
        "blocked.py",
        "root-only.py",
        "drop.tmp",
        "restored.tmp",
        "allowed.tmp",
        "local.py",
        "keep.py",
        ".secrets/token",
    ] {
        std::fs::write(subtree.join(path), "contents").unwrap();
    }
    let expected = serde_json::json!([
        ".marimohubignore",
        "allowed.tmp",
        "keep.py",
        "restored.tmp",
        "root-only.py"
    ]);
    let single = command(&checkout)
        .args(["--root-path", "apps/nested", "--dry-run"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let single: serde_json::Value = serde_json::from_slice(&single).unwrap();
    assert_eq!(single["files"], expected);
    let manifest = checkout.join("apps.json");
    std::fs::write(
        &manifest,
        r#"[{"path":"apps/nested","pid":"proj-test","nid":"nb-test","secret":"SYNC_TEST"}]"#,
    )
    .unwrap();
    let output = cargo_bin_cmd!("mohub")
        .current_dir(&checkout)
        .env("MARIMOHUB_NO_UPDATE_CHECK", "true")
        .args(["--output", "json", "notebooks", "push", "--manifest"])
        .arg(&manifest)
        .args([
            "--repo",
            "org/repo",
            "--branch",
            "main",
            "--commit",
            "abc123",
            "--dry-run",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let bulk: serde_json::Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(bulk["notebooks"][0]["data"]["files"], expected);
}

#[test]
fn include_git_rejects_credentials_in_fetch_and_push_urls() {
    for (key, remote) in [
        (
            "remote.origin.url",
            "https://token@example.com/org/repo.git",
        ),
        ("remote.origin.url", "http://token@example.com/org/repo.git"),
        (
            "remote.origin.url",
            "https://user:token@example.com/org/repo.git",
        ),
        (
            "remote.origin.pushurl",
            "https://user:token@example.com/org/repo.git",
        ),
        (
            "remote.origin.pushurl",
            "http://token@example.com/org/repo.git",
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        for args in [
            vec!["init", "--quiet"],
            vec!["config", "--local", key, remote],
        ] {
            assert!(std::process::Command::new("git")
                .current_dir(dir.path())
                .args(args)
                .status()
                .unwrap()
                .success());
        }
        command(dir.path())
            .args(["--include-git", "--dry-run"])
            .assert()
            .failure()
            .stderr(predicate::str::contains(
                "remove credentials from Git remote URLs",
            ))
            .stderr(predicate::str::contains(remote).not());
    }
}

fn git_repo(directory: &std::path::Path, commands: &[&[&str]]) {
    for args in std::iter::once(&["init", "--quiet"][..]).chain(commands.iter().copied()) {
        assert!(std::process::Command::new("git")
            .current_dir(directory)
            .args(["-c", "core.fsmonitor=false"])
            .args(args)
            .status()
            .unwrap()
            .success());
    }
}

#[test]
fn include_git_rejects_credentials_in_insteadof_keys() {
    let dir = tempfile::tempdir().unwrap();
    git_repo(
        dir.path(),
        &[&[
            "config",
            "--local",
            "url.https://x-access-token:ghs_secret@github.com/.insteadOf",
            "https://github.com/",
        ]],
    );
    command(dir.path())
        .args(["--include-git", "--dry-run"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("remove credentials from Git"))
        .stderr(predicate::str::contains("ghs_secret").not());
}

#[test]
fn include_git_rejects_includes_inside_git_dir() {
    let dir = tempfile::tempdir().unwrap();
    git_repo(
        dir.path(),
        &[&["config", "--local", "include.path", "creds"]],
    );
    std::fs::write(
        dir.path().join(".git/creds"),
        "[http]\n\textraheader = AUTHORIZATION: basic secret\n",
    )
    .unwrap();
    command(dir.path())
        .args(["--include-git", "--dry-run"])
        .assert()
        .failure()
        .stderr(predicate::str::contains(
            "remove the include of a file inside",
        ));
}

#[test]
fn include_git_screens_submodule_configs() {
    let dir = tempfile::tempdir().unwrap();
    git_repo(dir.path(), &[]);
    let module = dir.path().join(".git/modules/libs/inner");
    std::fs::create_dir_all(&module).unwrap();
    std::fs::write(module.join("HEAD"), "ref: refs/heads/main\n").unwrap();
    std::fs::write(
        module.join("config"),
        "[remote \"origin\"]\n\turl = https://token@example.com/org/inner.git\n",
    )
    .unwrap();
    command(dir.path())
        .args(["--include-git", "--dry-run"])
        .assert()
        .failure()
        .stderr(predicate::str::contains(".git/modules/libs/inner/config"))
        .stderr(predicate::str::contains("token@").not());
}

#[test]
fn include_git_accepts_clean_checkout() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("app.py"), "print(1)").unwrap();
    git_repo(
        dir.path(),
        &[
            &[
                "config",
                "--local",
                "remote.origin.url",
                "https://github.com/org/repo.git",
            ],
            &[
                "-c",
                "user.name=ci",
                "-c",
                "user.email=ci@example.com",
                "add",
                "app.py",
            ],
            &[
                "-c",
                "user.name=ci",
                "-c",
                "user.email=ci@example.com",
                "commit",
                "--quiet",
                "-m",
                "init",
            ],
        ],
    );
    let commit = String::from_utf8(
        std::process::Command::new("git")
            .current_dir(dir.path())
            .args(["-c", "core.fsmonitor=false", "rev-parse", "HEAD"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    cargo_bin_cmd!("mohub")
        .current_dir(dir.path())
        .env("MARIMOHUB_NO_UPDATE_CHECK", "true")
        .args([
            "--output",
            "json",
            "notebooks",
            "push",
            "--pid",
            "proj-test",
            "--nid",
            "nb-test",
            "--branch",
            "main",
            "--commit",
            commit.trim(),
            "--include-git",
            "--dry-run",
        ])
        .assert()
        .success()
        .stdout(predicate::str::contains(".git/config"));
}

#[test]
fn skips_credential_files_unless_opted_in() {
    let dir = tempfile::tempdir().unwrap();
    for path in [
        "app.py",
        ".env",
        ".env.local",
        ".netrc",
        "key.pem",
        "id_ed25519",
        "gha-creds-0123abcd.json",
    ] {
        std::fs::write(dir.path().join(path), "contents").unwrap();
    }
    let output = command(dir.path())
        .arg("--dry-run")
        .assert()
        .success()
        .stderr(predicate::str::contains(
            "skipping credential-like file .netrc",
        ))
        .get_output()
        .stdout
        .clone();
    let plan: serde_json::Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(plan["files"], serde_json::json!(["app.py"]));
    assert_eq!(
        plan["skipped_credential_files"],
        serde_json::json!([
            ".env",
            ".env.local",
            ".netrc",
            "gha-creds-0123abcd.json",
            "id_ed25519",
            "key.pem"
        ])
    );
    let output = command(dir.path())
        .args(["--dry-run", "--include-credential-files"])
        .assert()
        .success()
        .stderr(predicate::str::contains("skipping").not())
        .get_output()
        .stdout
        .clone();
    let plan: serde_json::Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(plan["files"].as_array().unwrap().len(), 7);
    assert_eq!(plan["skipped_credential_files"], serde_json::json!([]));
}

#[test]
fn bulk_push_forwards_credential_file_opt_in() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("app.py"), "print(1)").unwrap();
    std::fs::write(dir.path().join(".env"), "TOKEN=secret").unwrap();
    std::fs::write(
        dir.path().join("apps.json"),
        r#"[{"path":"","pid":"p","nid":"n","secret":"SYNC_TEST"}]"#,
    )
    .unwrap();
    let bulk = |extra: &[&str]| {
        let output = cargo_bin_cmd!("mohub")
            .current_dir(dir.path())
            .env("MARIMOHUB_NO_UPDATE_CHECK", "true")
            .args([
                "--output",
                "json",
                "notebooks",
                "push",
                "--manifest",
                "apps.json",
            ])
            .args([
                "--repo",
                "org/repo",
                "--branch",
                "main",
                "--commit",
                "abc123",
                "--dry-run",
            ])
            .args(extra)
            .assert()
            .success()
            .get_output()
            .stdout
            .clone();
        serde_json::from_slice::<serde_json::Value>(&output).unwrap()["notebooks"][0]["data"]
            .clone()
    };
    let default = bulk(&[]);
    assert_eq!(
        default["skipped_credential_files"],
        serde_json::json!([".env"])
    );
    assert!(!default["files"]
        .as_array()
        .unwrap()
        .contains(&".env".into()));
    let opted_in = bulk(&["--include-credential-files"]);
    assert!(opted_in["files"]
        .as_array()
        .unwrap()
        .contains(&".env".into()));
}
