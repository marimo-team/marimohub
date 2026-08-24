use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;

use assert_cmd::cargo::cargo_bin_cmd;
use predicates::prelude::*;

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
