use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::thread;

use assert_cmd::cargo::cargo_bin_cmd;
use predicates::prelude::*;
use tempfile::TempDir;

struct StubResponse {
    status: u16,
    body: &'static str,
    headers: Vec<(&'static str, &'static str)>,
}

impl StubResponse {
    fn json(status: u16, body: &'static str) -> Self {
        Self {
            status,
            body,
            headers: Vec::new(),
        }
    }

    fn with_header(mut self, name: &'static str, value: &'static str) -> Self {
        self.headers.push((name, value));
        self
    }
}

fn serve_sequence(responses: Vec<StubResponse>) -> (String, thread::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
    let address = listener.local_addr().expect("test server address");
    let handle = thread::spawn(move || {
        responses
            .into_iter()
            .map(|response| {
                let (mut stream, _) = listener.accept().expect("accept request");
                let mut reader = BufReader::new(stream.try_clone().expect("clone request stream"));
                let mut request = String::new();
                let mut content_length = 0;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).expect("read request line");
                    assert!(!line.is_empty(), "request ended before headers completed");
                    if let Some((name, value)) = line.split_once(':') {
                        if name.eq_ignore_ascii_case("content-length") {
                            content_length = value.trim().parse().expect("valid content length");
                        }
                    }
                    request.push_str(&line);
                    if line == "\r\n" {
                        break;
                    }
                }
                let mut body = vec![0; content_length];
                reader.read_exact(&mut body).expect("read request body");
                request.push_str(&String::from_utf8(body).expect("UTF-8 request body"));

                let extra_headers = response
                    .headers
                    .iter()
                    .map(|(name, value)| format!("{name}: {value}\r\n"))
                    .collect::<String>();
                write!(
                    stream,
                    "HTTP/1.1 {} Test\r\nContent-Type: application/json\r\n{}Content-Length: {}\r\nConnection: close\r\n\r\n{}",
                    response.status,
                    extra_headers,
                    response.body.len(),
                    response.body,
                )
                .expect("write response");
                request
            })
            .collect()
    });
    (format!("http://{address}"), handle)
}

fn deploy_fixture(notebooks: &str, files: &[(&str, &str)]) -> (TempDir, String) {
    let temp = TempDir::new().expect("temporary deploy project");
    for (path, contents) in files {
        fs::write(temp.path().join(path), contents).expect("write deploy file");
    }
    let config = temp.path().join("marimohub.toml");
    fs::write(
        &config,
        format!("project_id = \"proj-7h2k9qm4xz7rp3w8\"\n{notebooks}"),
    )
    .expect("write deploy config");
    (temp, config.display().to_string())
}

fn local_detail(title: &'static str, source_type: &'static str) -> &'static str {
    match (title, source_type) {
        ("Old", "local") => {
            r#"{"success":true,"data":{"meta":{"title":"Old","description":"D","tags":[]},"readme":null,"source":{"type":"local"}}}"#
        }
        ("Same", "local") => {
            r#"{"success":true,"data":{"meta":{"title":"Same","description":"D","tags":[]},"readme":null,"source":{"type":"local"}}}"#
        }
        (_, "git") => {
            r#"{"success":true,"data":{"meta":{"title":"Git","description":"D","tags":[]},"readme":null,"source":{"type":"git"}}}"#
        }
        _ => unreachable!(),
    }
}

fn serve_once(status: u16, body: &str) -> (String, thread::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
    let address = listener.local_addr().expect("test server address");
    let body = body.to_owned();
    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept request");
        let mut request = [0; 8192];
        let length = stream.read(&mut request).expect("read request");
        let request = String::from_utf8_lossy(&request[..length]).into_owned();
        write!(
            stream,
            "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len(),
        )
        .expect("write response");
        request
    });
    (format!("http://{address}"), handle)
}

#[test]
fn help_lists_human_and_machine_output_modes() {
    cargo_bin_cmd!("mohub")
        .arg("--help")
        .assert()
        .success()
        .stdout(predicate::str::contains("jsonl"))
        .stdout(predicate::str::contains("table"))
        .stdout(predicate::str::contains("csv"));
}

#[test]
fn table_output_is_human_readable_and_keeps_secrets_out_of_stdout() {
    let (base_url, server) = serve_once(
        200,
        r#"{"success":true,"data":[{"name":"sessions","enabled":true},{"name":"audit","enabled":false}]}"#,
    );

    cargo_bin_cmd!("mohub")
        .args([
            "--base-url",
            &base_url,
            "--token",
            "mhub_pat_test",
            "--output",
            "table",
            "capabilities",
        ])
        .assert()
        .success()
        .stdout(predicate::str::contains("NAME"))
        .stdout(predicate::str::contains("sessions"))
        .stdout(predicate::str::contains("mhub_pat_test").not());

    let request = server.join().expect("test server completed");
    assert!(request.starts_with("GET /api/v1/capabilities HTTP/1.1"));
    assert!(request
        .to_ascii_lowercase()
        .contains("authorization: bearer mhub_pat_test"));
}

#[test]
fn csv_output_has_no_terminal_decoration() {
    let (base_url, server) = serve_once(
        200,
        r#"{"success":true,"data":[{"enabled":true,"name":"sessions"}]}"#,
    );

    cargo_bin_cmd!("mohub")
        .args([
            "--base-url",
            &base_url,
            "--token",
            "mhub_pat_test",
            "--output",
            "csv",
            "capabilities",
        ])
        .assert()
        .success()
        .stdout("enabled,name\ntrue,sessions\n")
        .stderr("");

    server.join().expect("test server completed");
}

#[test]
fn http_errors_are_diagnostic_and_do_not_echo_the_token() {
    let (base_url, server) = serve_once(
        401,
        r#"{"success":false,"error":{"code":"UNAUTHORIZED","message":"Authentication required"}}"#,
    );

    cargo_bin_cmd!("mohub")
        .args(["--base-url", &base_url, "--token", "mhub_pat_secret", "me"])
        .assert()
        .failure()
        .stdout("")
        .stderr(predicate::str::contains("HTTP 401 UNAUTHORIZED"))
        .stderr(predicate::str::contains("mhub_pat_secret").not());

    server.join().expect("test server completed");
}

#[test]
fn notebooks_help_distinguishes_deploy_from_update() {
    cargo_bin_cmd!("mohub")
        .args(["notebooks", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("deploy"))
        .stdout(predicate::str::contains("update"));
}

#[test]
fn deploy_rejects_raw_envelope_before_reading_configuration() {
    let temp = TempDir::new().unwrap();
    let missing_config = temp.path().join("missing.toml");

    cargo_bin_cmd!("mohub")
        .args([
            "notebooks",
            "deploy",
            "--raw-envelope",
            "--config",
            &missing_config.display().to_string(),
        ])
        .assert()
        .failure()
        .stdout("")
        .stderr(predicate::str::contains(
            "--raw-envelope cannot be combined with notebooks deploy",
        ))
        .stderr(predicate::str::contains("could not resolve configuration").not())
        .stderr(predicate::str::contains("no server URL").not());
}

#[test]
fn deploy_updates_changed_code_with_the_preflight_etag() {
    let (_temp, config) = deploy_fixture(
        "notebook_id = \"nb-7h2k9qm4xz7rp3w8\"\npath = \"app.py\"\ntitle = \"New\"\n",
        &[("app.py", "print('new')")],
    );
    let (base_url, server) = serve_sequence(vec![
        StubResponse::json(200, local_detail("Old", "local")).with_header("ETag", "\"etag-1\""),
        StubResponse::json(200, r#"{"success":true,"data":{"code":"print('old')"}}"#),
        StubResponse::json(200, r#"{"success":true,"data":{"id":"nb"}}"#),
    ]);

    cargo_bin_cmd!("mohub")
        .args([
            "--base-url",
            &base_url,
            "--token",
            "mhub_pat_secret",
            "notebooks",
            "deploy",
            "--config",
            &config,
        ])
        .assert()
        .success()
        .stdout(predicate::str::contains(r#""action": "updated""#))
        .stdout(predicate::str::contains(r#""code""#))
        .stdout(predicate::str::contains("print('new')").not())
        .stdout(predicate::str::contains("mhub_pat_secret").not());

    let requests = server.join().expect("test server completed");
    assert!(requests[0].starts_with(
        "GET /api/v1/projects/proj-7h2k9qm4xz7rp3w8/notebooks/nb-7h2k9qm4xz7rp3w8 HTTP/1.1"
    ));
    assert!(requests[1].starts_with(
        "GET /api/v1/projects/proj-7h2k9qm4xz7rp3w8/notebooks/nb-7h2k9qm4xz7rp3w8/content HTTP/1.1"
    ));
    assert!(requests[2].starts_with(
        "PATCH /api/v1/projects/proj-7h2k9qm4xz7rp3w8/notebooks/nb-7h2k9qm4xz7rp3w8 HTTP/1.1"
    ));
    assert!(requests[2]
        .to_ascii_lowercase()
        .contains("if-match: \"etag-1\""));
    assert!(requests[2].contains(r#""code":"print('new')""#));
    assert!(requests[2].contains(r#""message":"Deploy app.py""#));
    assert!(requests[2].contains(r#""title":"New""#));
}

#[test]
fn dry_run_and_unchanged_deploys_do_not_patch() {
    let (_temp, config) = deploy_fixture(
        "notebook_id = \"nb-7h2k9qm4xz7rp3w8\"\npath = \"app.py\"\n",
        &[("app.py", "print('new')")],
    );
    let (base_url, server) = serve_sequence(vec![
        StubResponse::json(200, local_detail("Old", "local")).with_header("ETag", "\"etag-1\""),
        StubResponse::json(200, r#"{"success":true,"data":{"code":"print('old')"}}"#),
    ]);

    cargo_bin_cmd!("mohub")
        .args([
            "--base-url",
            &base_url,
            "--token",
            "mhub_pat_test",
            "notebooks",
            "deploy",
            "--config",
            &config,
            "--dry-run",
        ])
        .assert()
        .success()
        .stdout(predicate::str::contains(r#""action": "planned""#));
    assert_eq!(server.join().unwrap().len(), 2);

    fs::write(_temp.path().join("app.py"), "print('same')").unwrap();
    let (base_url, server) = serve_sequence(vec![
        StubResponse::json(200, local_detail("Same", "local")).with_header("ETag", "\"etag-2\""),
        StubResponse::json(200, r#"{"success":true,"data":{"code":"print('same')"}}"#),
    ]);
    cargo_bin_cmd!("mohub")
        .args([
            "--base-url",
            &base_url,
            "--token",
            "mhub_pat_test",
            "notebooks",
            "deploy",
            "--config",
            &config,
        ])
        .assert()
        .success()
        .stdout(predicate::str::contains(r#""action": "unchanged""#));
    assert_eq!(server.join().unwrap().len(), 2);
}

#[test]
fn multi_notebook_deploy_finishes_preflight_before_writing() {
    let (_temp, config) = deploy_fixture(
        r#"
[notebooks.alpha]
notebook_id = "nb-7h2k9qm4xz7rp3w8"
path = "alpha.py"
[notebooks.zebra]
notebook_id = "nb-8h2k9qm4xz7rp3w8"
path = "zebra.py"
"#,
        &[("alpha.py", "alpha = 2"), ("zebra.py", "zebra = 2")],
    );
    let (base_url, server) = serve_sequence(vec![
        StubResponse::json(200, local_detail("Old", "local")).with_header("ETag", "\"etag-a\""),
        StubResponse::json(200, r#"{"success":true,"data":{"code":"alpha = 1"}}"#),
        StubResponse::json(200, local_detail("Old", "local")).with_header("ETag", "\"etag-z\""),
        StubResponse::json(200, r#"{"success":true,"data":{"code":"zebra = 1"}}"#),
        StubResponse::json(200, r#"{"success":true,"data":{}}"#),
        StubResponse::json(200, r#"{"success":true,"data":{}}"#),
    ]);

    cargo_bin_cmd!("mohub")
        .args([
            "--base-url",
            &base_url,
            "--token",
            "mhub_pat_test",
            "notebooks",
            "deploy",
            "--config",
            &config,
        ])
        .assert()
        .success();

    let requests = server.join().unwrap();
    assert!(requests[0].contains("nb-7h2k9qm4xz7rp3w8"));
    assert!(requests[2].contains("nb-8h2k9qm4xz7rp3w8"));
    assert!(requests[..4]
        .iter()
        .all(|request| request.starts_with("GET ")));
    assert!(requests[4].starts_with("PATCH "));
    assert!(requests[5].starts_with("PATCH "));
}

#[test]
fn failed_remote_preflight_prevents_all_writes() {
    let (_temp, config) = deploy_fixture(
        r#"
[notebooks.alpha]
notebook_id = "nb-7h2k9qm4xz7rp3w8"
path = "alpha.py"
[notebooks.zebra]
notebook_id = "nb-8h2k9qm4xz7rp3w8"
path = "zebra.py"
"#,
        &[("alpha.py", "alpha = 2"), ("zebra.py", "zebra = 2")],
    );
    let (base_url, server) = serve_sequence(vec![
        StubResponse::json(200, local_detail("Old", "local")).with_header("ETag", "\"etag-a\""),
        StubResponse::json(200, r#"{"success":true,"data":{"code":"alpha = 1"}}"#),
        StubResponse::json(
            404,
            r#"{"success":false,"error":{"code":"NOT_FOUND","message":"Notebook not found"}}"#,
        ),
    ]);

    cargo_bin_cmd!("mohub")
        .args([
            "--base-url",
            &base_url,
            "--token",
            "mhub_pat_test",
            "notebooks",
            "deploy",
            "--config",
            &config,
        ])
        .assert()
        .failure()
        .stdout("")
        .stderr(predicate::str::contains("HTTP 404 NOT_FOUND"));

    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 3);
    assert!(requests.iter().all(|request| request.starts_with("GET ")));
}

#[test]
fn malformed_remote_preflight_prevents_all_writes() {
    let (_temp, config) = deploy_fixture(
        r#"
[notebooks.alpha]
notebook_id = "nb-7h2k9qm4xz7rp3w8"
path = "alpha.py"
[notebooks.zebra]
notebook_id = "nb-8h2k9qm4xz7rp3w8"
path = "zebra.py"
"#,
        &[("alpha.py", "alpha = 2"), ("zebra.py", "zebra = 2")],
    );
    let (base_url, server) = serve_sequence(vec![
        StubResponse::json(200, local_detail("Old", "local")).with_header("ETag", "\"etag-a\""),
        StubResponse::json(200, r#"{"success":true,"data":{"code":"alpha = 1"}}"#),
        StubResponse::json(200, r#"{"success":true,"data":{"meta":{"title":"Old"}}}"#)
            .with_header("ETag", "\"etag-z\""),
    ]);

    cargo_bin_cmd!("mohub")
        .args([
            "--base-url",
            &base_url,
            "--token",
            "mhub_pat_test",
            "notebooks",
            "deploy",
            "--config",
            &config,
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains("no valid tags"));

    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 3);
    assert!(requests.iter().all(|request| request.starts_with("GET ")));
}

#[test]
fn missing_etag_stops_before_the_content_request() {
    let (_temp, config) = deploy_fixture(
        "notebook_id = \"nb-7h2k9qm4xz7rp3w8\"\npath = \"app.py\"\n",
        &[("app.py", "print('new')")],
    );
    let (base_url, server) =
        serve_sequence(vec![StubResponse::json(200, local_detail("Old", "local"))]);

    cargo_bin_cmd!("mohub")
        .args([
            "--base-url",
            &base_url,
            "--token",
            "mhub_pat_test",
            "notebooks",
            "deploy",
            "--config",
            &config,
        ])
        .assert()
        .failure()
        .stdout("")
        .stderr(predicate::str::contains("did not return an ETag"));

    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].starts_with("GET "));
}

#[test]
fn transient_preflight_get_is_retried_before_planning() {
    let (_temp, config) = deploy_fixture(
        "notebook_id = \"nb-7h2k9qm4xz7rp3w8\"\npath = \"app.py\"\n",
        &[("app.py", "print('same')")],
    );
    let (base_url, server) = serve_sequence(vec![
        StubResponse::json(
            503,
            r#"{"success":false,"error":{"code":"SERVICE_UNAVAILABLE","message":"Try again"}}"#,
        ),
        StubResponse::json(200, local_detail("Old", "local")).with_header("ETag", "\"etag-1\""),
        StubResponse::json(200, r#"{"success":true,"data":{"code":"print('same')"}}"#),
    ]);

    cargo_bin_cmd!("mohub")
        .args([
            "--base-url",
            &base_url,
            "--token",
            "mhub_pat_test",
            "notebooks",
            "deploy",
            "--config",
            &config,
        ])
        .assert()
        .success()
        .stdout(predicate::str::contains(r#""action": "unchanged""#));

    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 3);
    assert_eq!(
        requests[0].lines().next(),
        requests[1].lines().next(),
        "the detail GET is retried"
    );
    assert!(requests.iter().all(|request| request.starts_with("GET ")));
}

#[test]
fn malformed_content_stops_before_any_patch() {
    let (_temp, config) = deploy_fixture(
        "notebook_id = \"nb-7h2k9qm4xz7rp3w8\"\npath = \"app.py\"\n",
        &[("app.py", "print('new')")],
    );
    let (base_url, server) = serve_sequence(vec![
        StubResponse::json(200, local_detail("Old", "local")).with_header("ETag", "\"etag-1\""),
        StubResponse::json(200, r#"{"success":true,"data":{"code":42}}"#),
    ]);

    cargo_bin_cmd!("mohub")
        .args([
            "--base-url",
            &base_url,
            "--token",
            "mhub_pat_test",
            "notebooks",
            "deploy",
            "--config",
            &config,
        ])
        .assert()
        .failure()
        .stdout("")
        .stderr(predicate::str::contains("no valid code"));

    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests.iter().all(|request| request.starts_with("GET ")));
}

#[test]
fn metadata_only_update_omits_code_and_message() {
    let (_temp, config) = deploy_fixture(
        "notebook_id = \"nb-7h2k9qm4xz7rp3w8\"\npath = \"app.py\"\ntitle = \"New\"\nbase_image = false\n",
        &[("app.py", "print('same')")],
    );
    let (base_url, server) = serve_sequence(vec![
        StubResponse::json(
            200,
            r#"{"success":true,"data":{"meta":{"title":"Old","description":"D","tags":[],"base_image":"custom"},"readme":null,"source":{"type":"local"}}}"#,
        )
        .with_header("ETag", "\"etag-1\""),
        StubResponse::json(200, r#"{"success":true,"data":{"code":"print('same')"}}"#),
        StubResponse::json(200, r#"{"success":true,"data":{}}"#),
    ]);

    cargo_bin_cmd!("mohub")
        .args([
            "--base-url",
            &base_url,
            "--token",
            "mhub_pat_test",
            "notebooks",
            "deploy",
            "--config",
            &config,
            "--message",
            "Must not be sent",
        ])
        .assert()
        .success()
        .stdout(predicate::str::contains(
            r#""changes": [
        "base_image",
        "title"
      ]"#,
        ));

    let requests = server.join().unwrap();
    assert!(requests[2].starts_with("PATCH "));
    assert!(requests[2].contains(r#""base_image":null"#));
    assert!(requests[2].contains(r#""title":"New""#));
    assert!(!requests[2].contains(r#""code""#));
    assert!(!requests[2].contains(r#""message""#));
    assert!(!requests[2].contains("Must not be sent"));
}

#[test]
fn pyproject_discovery_and_path_inference_work_together() {
    let temp = TempDir::new().unwrap();
    fs::write(temp.path().join("app.py"), "print('same')").unwrap();
    fs::write(
        temp.path().join("pyproject.toml"),
        r#"[project]
name = "demo"

[tool.marimohub]
project_id = "proj-7h2k9qm4xz7rp3w8"
notebook_id = "nb-7h2k9qm4xz7rp3w8"
"#,
    )
    .unwrap();
    let (base_url, server) = serve_sequence(vec![
        StubResponse::json(200, local_detail("Old", "local")).with_header("ETag", "\"etag-1\""),
        StubResponse::json(200, r#"{"success":true,"data":{"code":"print('same')"}}"#),
    ]);

    cargo_bin_cmd!("mohub")
        .current_dir(temp.path())
        .args([
            "--base-url",
            &base_url,
            "--token",
            "mhub_pat_test",
            "notebooks",
            "deploy",
        ])
        .assert()
        .success()
        .stdout(predicate::str::contains(r#""action": "unchanged""#))
        .stdout(predicate::str::contains("pyproject.toml"));

    assert_eq!(server.join().unwrap().len(), 2);
}

#[test]
fn notebook_selector_reads_and_updates_only_the_selected_entry() {
    let (_temp, config) = deploy_fixture(
        r#"
[notebooks.alpha]
notebook_id = "nb-7h2k9qm4xz7rp3w8"
path = "alpha.py"
[notebooks.zebra]
notebook_id = "nb-8h2k9qm4xz7rp3w8"
path = "zebra.py"
"#,
        &[("zebra.py", "zebra = 2")],
    );
    let (base_url, server) = serve_sequence(vec![
        StubResponse::json(200, local_detail("Old", "local")).with_header("ETag", "\"etag-z\""),
        StubResponse::json(200, r#"{"success":true,"data":{"code":"zebra = 1"}}"#),
        StubResponse::json(200, r#"{"success":true,"data":{}}"#),
    ]);

    cargo_bin_cmd!("mohub")
        .args([
            "--base-url",
            &base_url,
            "--token",
            "mhub_pat_test",
            "notebooks",
            "deploy",
            "--config",
            &config,
            "--notebook",
            "zebra",
        ])
        .assert()
        .success()
        .stdout(predicate::str::contains(r#""name": "zebra""#))
        .stdout(predicate::str::contains(r#""name": "alpha""#).not());

    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 3);
    assert!(requests
        .iter()
        .all(|request| request.contains("nb-8h2k9qm4xz7rp3w8")));
}

#[test]
fn precondition_failure_is_not_retried() {
    let (_temp, config) = deploy_fixture(
        "notebook_id = \"nb-7h2k9qm4xz7rp3w8\"\npath = \"app.py\"\n",
        &[("app.py", "print('new')")],
    );
    let (base_url, server) = serve_sequence(vec![
        StubResponse::json(200, local_detail("Old", "local")).with_header("ETag", "\"etag-1\""),
        StubResponse::json(200, r#"{"success":true,"data":{"code":"print('old')"}}"#),
        StubResponse::json(
            412,
            r#"{"success":false,"error":{"code":"PRECONDITION_FAILED","message":"Notebook changed"}}"#,
        ),
    ]);

    cargo_bin_cmd!("mohub")
        .args([
            "--base-url",
            &base_url,
            "--token",
            "mhub_pat_test",
            "notebooks",
            "deploy",
            "--config",
            &config,
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains("HTTP 412"))
        .stderr(predicate::str::contains("PRECONDITION_FAILED"));

    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 3);
    assert_eq!(
        requests
            .iter()
            .filter(|request| request.starts_with("PATCH "))
            .count(),
        1
    );
}

#[test]
fn rerun_after_partial_apply_skips_the_completed_notebook() {
    let (_temp, config) = deploy_fixture(
        r#"
[notebooks.alpha]
notebook_id = "nb-7h2k9qm4xz7rp3w8"
path = "alpha.py"
[notebooks.zebra]
notebook_id = "nb-8h2k9qm4xz7rp3w8"
path = "zebra.py"
"#,
        &[("alpha.py", "alpha = 2"), ("zebra.py", "zebra = 2")],
    );
    let (base_url, server) = serve_sequence(vec![
        StubResponse::json(200, local_detail("Old", "local")).with_header("ETag", "\"etag-a\""),
        StubResponse::json(200, r#"{"success":true,"data":{"code":"alpha = 1"}}"#),
        StubResponse::json(200, local_detail("Old", "local")).with_header("ETag", "\"etag-z\""),
        StubResponse::json(200, r#"{"success":true,"data":{"code":"zebra = 1"}}"#),
        StubResponse::json(200, r#"{"success":true,"data":{}}"#),
        StubResponse::json(
            500,
            r#"{"success":false,"error":{"code":"INTERNAL_ERROR","message":"Try again"}}"#,
        ),
    ]);

    cargo_bin_cmd!("mohub")
        .args([
            "--base-url",
            &base_url,
            "--token",
            "mhub_pat_test",
            "notebooks",
            "deploy",
            "--config",
            &config,
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains("already updated: alpha"));
    assert_eq!(
        server
            .join()
            .unwrap()
            .iter()
            .filter(|request| request.starts_with("PATCH "))
            .count(),
        2
    );

    let (base_url, server) = serve_sequence(vec![
        StubResponse::json(200, local_detail("Old", "local")).with_header("ETag", "\"etag-a2\""),
        StubResponse::json(200, r#"{"success":true,"data":{"code":"alpha = 2"}}"#),
        StubResponse::json(200, local_detail("Old", "local")).with_header("ETag", "\"etag-z2\""),
        StubResponse::json(200, r#"{"success":true,"data":{"code":"zebra = 1"}}"#),
        StubResponse::json(200, r#"{"success":true,"data":{}}"#),
    ]);
    cargo_bin_cmd!("mohub")
        .args([
            "--base-url",
            &base_url,
            "--token",
            "mhub_pat_test",
            "notebooks",
            "deploy",
            "--config",
            &config,
        ])
        .assert()
        .success();

    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 5);
    assert!(requests[4].starts_with("PATCH "));
    assert!(requests[4].contains("nb-8h2k9qm4xz7rp3w8"));
}

#[test]
fn git_backed_notebook_is_rejected_without_a_patch() {
    let (_temp, config) = deploy_fixture(
        "notebook_id = \"nb-7h2k9qm4xz7rp3w8\"\npath = \"app.py\"\n",
        &[("app.py", "print('new')")],
    );
    let (base_url, server) = serve_sequence(vec![
        StubResponse::json(200, local_detail("Git", "git")).with_header("ETag", "\"etag-git\""),
        StubResponse::json(200, r#"{"success":true,"data":{"code":"print('old')"}}"#),
    ]);

    cargo_bin_cmd!("mohub")
        .args([
            "--base-url",
            &base_url,
            "--token",
            "mhub_pat_test",
            "notebooks",
            "deploy",
            "--config",
            &config,
        ])
        .assert()
        .failure()
        .stdout("")
        .stderr(predicate::str::contains("supports only local notebooks"));

    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests.iter().all(|request| request.starts_with("GET ")));
}

#[test]
fn invalid_local_configuration_fails_before_profile_resolution() {
    let temp = TempDir::new().unwrap();
    let config = temp.path().join("marimohub.toml");
    fs::write(
        &config,
        r#"project_id = "proj-7h2k9qm4xz7rp3w8"
notebook_id = "nb-7h2k9qm4xz7rp3w8"
"#,
    )
    .unwrap();

    cargo_bin_cmd!("mohub")
        .args([
            "notebooks",
            "deploy",
            "--config",
            &config.display().to_string(),
        ])
        .assert()
        .failure()
        .stdout("")
        .stderr(predicate::str::contains("set path for the notebook"))
        .stderr(predicate::str::contains("no server URL").not());
}

#[test]
fn unknown_selector_fails_before_profile_resolution() {
    let (_temp, config) = deploy_fixture(
        r#"
[notebooks.alpha]
notebook_id = "nb-7h2k9qm4xz7rp3w8"
path = "alpha.py"
[notebooks.zebra]
notebook_id = "nb-8h2k9qm4xz7rp3w8"
path = "zebra.py"
"#,
        &[("alpha.py", "alpha = 1"), ("zebra.py", "zebra = 1")],
    );

    cargo_bin_cmd!("mohub")
        .args([
            "notebooks",
            "deploy",
            "--config",
            &config,
            "--notebook",
            "missing",
        ])
        .assert()
        .failure()
        .stdout("")
        .stderr(predicate::str::contains(
            "unknown notebook selection missing",
        ))
        .stderr(predicate::str::contains(
            "available notebooks: alpha, zebra",
        ))
        .stderr(predicate::str::contains("no server URL").not());
}
