use std::fs;
use std::path::Path;

use assert_cmd::{cargo::cargo_bin_cmd, Command};
use predicates::prelude::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use time::{format_description::well_known::Rfc3339, Duration, OffsetDateTime};

fn generate(output: &Path, key: &str) -> Command {
    let mut command = cargo_bin_cmd!("mohub");
    command
        .args(["--base-url", "not a URL", "--token-file"])
        .arg(output.join("missing-token"))
        .args([
            "service-account",
            "generate",
            "--account",
            "ci-deploy",
            "--key",
            key,
            "--output-dir",
        ])
        .arg(output);
    command
}

fn account(id: &str, hash: u8) -> Value {
    json!({
        "id": id,
        "name": "Deploy automation",
        "actions": ["org-integration.manage"],
        "credentials": [{"id": "initial", "sha256": format!("{hash:064x}")}],
    })
}

fn read_accounts(output: &Path) -> Value {
    serde_json::from_slice(&fs::read(output.join("accounts.json")).unwrap()).unwrap()
}

#[test]
fn generates_offline_with_valid_digest_expiry_and_private_files() {
    let temp = TempDir::new().unwrap();
    let before = OffsetDateTime::now_utc();
    let mut tokens = Vec::new();
    for (directory, days) in [("default", 90), ("minimum", 1), ("maximum", 3650)] {
        let output = temp.path().join(directory);
        let mut command = generate(&output, "initial");
        if days != 90 {
            command.args(["--expires-in-days", &days.to_string()]);
        }
        command.assert().success().stdout("");
        let token_file = fs::read_to_string(output.join("token")).unwrap();
        assert!(token_file.ends_with('\n'));
        let token = token_file.trim();
        let secret = token.strip_prefix("mhub_sa_ci-deploy_initial_").unwrap();
        assert_eq!(secret.len(), 64);
        assert!(secret
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
        let accounts = read_accounts(&output);
        assert_eq!(accounts[0]["actions"], json!(["org-integration.manage"]));
        let credential = &accounts[0]["credentials"][0];
        assert_eq!(
            credential["sha256"],
            format!("{:x}", Sha256::digest(token.as_bytes()))
        );
        let expiry =
            OffsetDateTime::parse(credential["expires_at"].as_str().unwrap(), &Rfc3339).unwrap();
        assert!(expiry >= before + Duration::days(days));
        assert!(expiry <= OffsetDateTime::now_utc() + Duration::days(days));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for (path, mode) in [
                (&output, 0o700),
                (&output.join("accounts.json"), 0o600),
                (&output.join("token"), 0o600),
            ] {
                assert_eq!(
                    fs::metadata(path).unwrap().permissions().mode() & 0o777,
                    mode
                );
            }
        }
        tokens.push(token.to_owned());
    }
    assert_ne!(tokens[0], tokens[1]);
    assert_ne!(tokens[1], tokens[2]);
}

#[test]
fn rotation_preserves_other_accounts_and_existing_credentials() {
    let temp = TempDir::new().unwrap();
    let input = temp.path().join("input.json");
    let original = json!([account("ci-deploy", 1), account("another-account", 2)]);
    let raw = serde_json::to_string(&original).unwrap();
    fs::write(&input, &raw).unwrap();
    let output = temp.path().join("rotated");
    generate(&output, "rotated")
        .arg("--config")
        .arg(&input)
        .assert()
        .success()
        .stdout("");
    assert_eq!(fs::read_to_string(input).unwrap(), raw);
    let rotated = read_accounts(&output);
    assert_eq!(rotated[1], original[1]);
    assert_eq!(rotated[0]["name"], original[0]["name"]);
    assert_eq!(rotated[0]["credentials"][0], original[0]["credentials"][0]);
    assert_eq!(rotated[0]["credentials"].as_array().unwrap().len(), 2);
    assert_eq!(rotated[0]["credentials"][1]["id"], "rotated");
    assert!(fs::read_to_string(output.join("token"))
        .unwrap()
        .starts_with("mhub_sa_ci-deploy_rotated_"));
}

#[test]
fn existing_directory_is_never_overwritten() {
    let temp = TempDir::new().unwrap();
    let output = temp.path().join("existing");
    fs::create_dir(&output).unwrap();
    fs::write(output.join("token"), "existing secret").unwrap();
    generate(&output, "initial").assert().failure().stdout("");
    assert_eq!(
        fs::read_to_string(output.join("token")).unwrap(),
        "existing secret"
    );
    assert!(!output.join("accounts.json").exists());
}

#[cfg(unix)]
#[test]
fn symlink_output_is_never_followed() {
    let temp = TempDir::new().unwrap();
    let target = temp.path().join("target");
    fs::create_dir(&target).unwrap();
    let output = temp.path().join("link");
    std::os::unix::fs::symlink(&target, &output).unwrap();
    generate(&output, "initial").assert().failure().stdout("");
    assert_eq!(fs::read_dir(target).unwrap().count(), 0);
    assert!(fs::symlink_metadata(output)
        .unwrap()
        .file_type()
        .is_symlink());
}

#[test]
fn bad_arguments_fail_before_output() {
    let temp = TempDir::new().unwrap();
    for (index, extra) in [
        vec!["--expires-in-days", "0"],
        vec!["--expires-in-days", "3651"],
        vec!["--expires-in-days", "abc"],
        vec!["--expires-in-days", "-1"],
        vec!["--unknown"],
    ]
    .iter()
    .enumerate()
    {
        let output = temp.path().join(index.to_string());
        generate(&output, "initial")
            .args(extra)
            .assert()
            .failure()
            .stdout("");
        assert!(!output.exists());
    }
    for key in ["", "Uppercase", "under_score", "1first", "space key"] {
        let output = temp.path().join("bad-key");
        generate(&output, key).assert().failure().stdout("");
        assert!(!output.exists());
    }
    cargo_bin_cmd!("mohub")
        .args(["service-account", "generate"])
        .assert()
        .failure();
}

#[test]
fn invalid_configuration_never_exposes_input_or_writes_output() {
    let temp = TempDir::new().unwrap();
    let secret = "private-secret-that-must-not-appear";
    let mut unknown = account("ci-deploy", 1);
    unknown[secret] = json!(secret);
    let mut bad_hash = account("ci-deploy", 1);
    bad_hash["credentials"][0]["sha256"] = json!(secret);
    let mut bad_expiry = account("ci-deploy", 1);
    bad_expiry["credentials"][0]["expires_at"] = json!(secret);
    let mut bad_actions = account("ci-deploy", 1);
    bad_actions["actions"] = json!(["org-integration.manage", "org-integration.manage"]);
    let cases = [
        format!("[\"{secret}"),
        "null".into(),
        " ".into(),
        "[]".repeat(32769),
        json!([unknown]).to_string(),
        json!([bad_hash]).to_string(),
        json!([bad_expiry]).to_string(),
        json!([bad_actions]).to_string(),
        json!([account("ci-deploy", 1), account("ci-deploy", 2)]).to_string(),
        json!([account("ci-deploy", 1), account("other", 1)]).to_string(),
    ];
    for (index, raw) in cases.iter().enumerate() {
        let input = temp.path().join("input.json");
        fs::write(&input, raw).unwrap();
        let output = temp.path().join(index.to_string());
        generate(&output, "rotated")
            .arg("--config")
            .arg(input)
            .assert()
            .failure()
            .stdout("")
            .stderr(predicate::str::contains(secret).not());
        assert!(!output.exists());
    }
}

#[test]
fn duplicate_key_and_credential_or_account_limit_fail_without_output() {
    let temp = TempDir::new().unwrap();
    let mut full = account("ci-deploy", 1);
    full["credentials"] = json!((0..4)
        .map(|i| json!({"id": format!("key-{i}"), "sha256": format!("{i:064x}")}))
        .collect::<Vec<_>>());
    let full_accounts = (0..32)
        .map(|i| account(&format!("account-{i}"), i))
        .collect::<Vec<_>>();
    for (index, (config, key)) in [
        (json!([account("ci-deploy", 1)]), "initial"),
        (json!([full]), "fifth"),
        (json!(full_accounts), "initial"),
    ]
    .iter()
    .enumerate()
    {
        let input = temp.path().join("input.json");
        fs::write(&input, config.to_string()).unwrap();
        let output = temp.path().join(index.to_string());
        generate(&output, key)
            .arg("--config")
            .arg(input)
            .assert()
            .failure()
            .stdout("");
        assert!(!output.exists());
    }
}
