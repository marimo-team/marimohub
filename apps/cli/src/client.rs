use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{self, IsTerminal, Read, Write};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use clap::ArgMatches;
use indicatif::{ProgressBar, ProgressStyle};
use inquire::Confirm;
use secrecy::{ExposeSecret, SecretString};
use serde_json::{Map, Value};
use tabled::{builder::Builder, settings::Style};
use url::Url;

use crate::manifest::{
    BodyProperty, Manifest, Operation, Parameter, ParameterLocation, ResponseKind,
};
use crate::Error;

struct HttpResponse {
    status: u16,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

pub struct Runtime<'a> {
    pub base_url: &'a str,
    pub token: Option<&'a SecretString>,
    pub timeout: Duration,
    pub output: &'a str,
    pub raw_envelope: bool,
}

fn values(matches: &ArgMatches, id: &str, repeatable: bool) -> Vec<String> {
    if repeatable {
        matches
            .get_many::<String>(id)
            .map(|items| items.cloned().collect())
            .unwrap_or_default()
    } else {
        matches.get_one::<String>(id).cloned().into_iter().collect()
    }
}

fn parameter_values(matches: &ArgMatches, parameter: &Parameter) -> Vec<String> {
    values(
        matches,
        &format!("parameter:{}", parameter.name),
        parameter.repeatable,
    )
}

fn body_values(matches: &ArgMatches, property: &BodyProperty) -> Vec<String> {
    values(
        matches,
        &format!("body:{}", property.name),
        property.repeatable,
    )
}

fn parse_scalar(value: &str, value_type: &str) -> Result<Value, Error> {
    match value_type {
        "boolean" => value
            .parse::<bool>()
            .map(Value::Bool)
            .map_err(|_| Error::Usage(format!("expected a boolean, got {value:?}"))),
        "integer" => value
            .parse::<i64>()
            .map(Into::into)
            .map_err(|_| Error::Usage(format!("expected an integer, got {value:?}"))),
        "number" => value
            .parse::<f64>()
            .map_err(|_| Error::Usage(format!("expected a number, got {value:?}")))
            .and_then(|number| {
                serde_json::Number::from_f64(number)
                    .map(Value::Number)
                    .ok_or_else(|| Error::Usage("number must be finite".into()))
            }),
        "object" => Ok(serde_json::from_str(value)?),
        _ => Ok(Value::String(value.to_owned())),
    }
}

fn read_raw_body(source: &str) -> Result<Vec<u8>, Error> {
    let bytes = if source == "-" {
        let mut bytes = Vec::new();
        io::stdin().read_to_end(&mut bytes)?;
        bytes
    } else if let Some(path) = source.strip_prefix('@') {
        fs::read(path)?
    } else {
        source.as_bytes().to_vec()
    };
    serde_json::from_slice::<Value>(&bytes)?;
    Ok(bytes)
}

fn request_body(operation: &Operation, matches: &ArgMatches) -> Result<Option<Vec<u8>>, Error> {
    let Some(body) = &operation.body else {
        return Ok(None);
    };
    if let Some(source) = matches.get_one::<String>("raw-body") {
        let has_typed = body
            .properties
            .iter()
            .any(|property| !body_values(matches, property).is_empty());
        if has_typed {
            return Err(Error::Usage(
                "--body cannot be combined with typed request-body flags".into(),
            ));
        }
        return read_raw_body(source).map(Some);
    }

    let mut document = Map::new();
    for property in &body.properties {
        let supplied = body_values(matches, property);
        if property.required && supplied.is_empty() {
            return Err(Error::Usage(format!(
                "--{} is required unless --body is supplied",
                property.cli_name
            )));
        }
        if supplied.is_empty() {
            continue;
        }
        let value = if property.repeatable {
            Value::Array(
                supplied
                    .iter()
                    .map(|value| parse_scalar(value, &property.value_type))
                    .collect::<Result<_, _>>()?,
            )
        } else {
            parse_scalar(&supplied[0], &property.value_type)?
        };
        document.insert(property.name.clone(), value);
    }
    if document.is_empty() && body.required {
        return Err(Error::Usage("this operation requires a JSON body".into()));
    }
    if document.is_empty() {
        Ok(None)
    } else {
        Ok(Some(serde_json::to_vec(&document)?))
    }
}

fn build_url(
    runtime: &Runtime<'_>,
    operation: &Operation,
    matches: &ArgMatches,
    cursor_override: Option<&str>,
) -> Result<Url, Error> {
    let mut path = operation.path.clone();
    for parameter in operation
        .parameters
        .iter()
        .filter(|parameter| parameter.location == ParameterLocation::Path)
    {
        let supplied = parameter_values(matches, parameter);
        let value = supplied
            .first()
            .ok_or_else(|| Error::Usage(format!("missing --{}", parameter.cli_name)))?;
        path = path.replace(
            &format!("{{{}}}", parameter.name),
            &urlencoding::encode(value),
        );
    }
    let mut url = Url::parse(&format!(
        "{}{}",
        runtime.base_url.trim_end_matches('/'),
        path
    ))?;
    {
        let mut query = url.query_pairs_mut();
        for parameter in operation
            .parameters
            .iter()
            .filter(|parameter| parameter.location == ParameterLocation::Query)
        {
            if parameter.name == "cursor" {
                if let Some(cursor) = cursor_override {
                    query.append_pair(&parameter.name, cursor);
                    continue;
                }
            }
            for value in parameter_values(matches, parameter) {
                query.append_pair(&parameter.name, &value);
            }
        }
    }
    Ok(url)
}

fn request_headers(
    operation: &Operation,
    matches: &ArgMatches,
    if_match: Option<&str>,
    idempotency_key: Option<&str>,
) -> BTreeMap<String, String> {
    let mut headers = BTreeMap::new();
    for parameter in operation
        .parameters
        .iter()
        .filter(|parameter| parameter.location == ParameterLocation::Header)
    {
        let lower = parameter.name.to_ascii_lowercase();
        if lower == "if-match" || lower == "idempotency-key" {
            continue;
        }
        if let Some(value) = parameter_values(matches, parameter).first() {
            headers.insert(parameter.name.clone(), value.clone());
        }
    }
    if let Some(value) = if_match {
        headers.insert("If-Match".into(), value.into());
    }
    if let Some(value) = idempotency_key {
        headers.insert("Idempotency-Key".into(), value.into());
    }
    headers
}

fn send_once(
    agent: &ureq::Agent,
    runtime: &Runtime<'_>,
    method: &str,
    url: &Url,
    headers: &BTreeMap<String, String>,
    body: Option<&[u8]>,
) -> Result<HttpResponse, Error> {
    let mut request = agent
        .request(method, url.as_str())
        .set("Accept", "application/json");
    if let Some(token) = runtime.token {
        request = request.set(
            "Authorization",
            &format!("Bearer {}", token.expose_secret()),
        );
    }
    for (name, value) in headers {
        request = request.set(name, value);
    }
    let result = match body {
        Some(bytes) => request
            .set("Content-Type", "application/json")
            .send_bytes(bytes),
        None => request.call(),
    };
    let response = match result {
        Ok(response) => response,
        Err(ureq::Error::Status(_, response)) => response,
        Err(error) => return Err(error.into()),
    };
    let status = response.status();
    let mut response_headers = BTreeMap::new();
    for name in response.headers_names() {
        if let Some(value) = response.header(&name) {
            response_headers.insert(name.to_ascii_lowercase(), value.to_owned());
        }
    }
    let mut response_body = Vec::new();
    response.into_reader().read_to_end(&mut response_body)?;
    Ok(HttpResponse {
        status,
        headers: response_headers,
        body: response_body,
    })
}

fn send(
    agent: &ureq::Agent,
    runtime: &Runtime<'_>,
    operation: &Operation,
    url: &Url,
    headers: &BTreeMap<String, String>,
    body: Option<&[u8]>,
) -> Result<HttpResponse, Error> {
    let retryable = operation.method == "GET"
        || operation.method == "HEAD"
        || headers.contains_key("Idempotency-Key");
    for attempt in 0..3 {
        match send_once(agent, runtime, &operation.method, url, headers, body) {
            Ok(response)
                if retryable && attempt < 2 && matches!(response.status, 500 | 502 | 503 | 504) => {
            }
            Ok(response) => return Ok(response),
            Err(error) if retryable && attempt < 2 => {
                if !matches!(error, Error::Transport(_)) {
                    return Err(error);
                }
            }
            Err(error) => return Err(error),
        }
        thread::sleep(Duration::from_millis(150 * (1 << attempt)));
    }
    unreachable!()
}

fn generated_idempotency_key() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("mohub-{}-{nanos}", std::process::id())
}

fn confirm(operation: &Operation, matches: &ArgMatches) -> Result<(), Error> {
    if !operation.destructive || matches.get_flag("yes") {
        return Ok(());
    }
    if !io::stdin().is_terminal() {
        return Err(Error::Usage(format!(
            "{} is destructive; pass --yes in non-interactive environments",
            operation.id
        )));
    }
    match Confirm::new(&format!("Run destructive operation {}?", operation.id))
        .with_default(false)
        .prompt()
    {
        Ok(true) => Ok(()),
        Ok(false)
        | Err(inquire::InquireError::OperationCanceled)
        | Err(inquire::InquireError::OperationInterrupted) => Err(Error::Cancelled),
        Err(error) => Err(Error::Prompt(error.to_string())),
    }
}

fn ensure_success(response: &HttpResponse) -> Result<Value, Error> {
    let parsed: Value = serde_json::from_slice(&response.body).map_err(|error| {
        Error::Http(format!(
            "server returned HTTP {} with an invalid JSON response: {error}",
            response.status
        ))
    })?;
    if !(200..300).contains(&response.status) {
        let code = parsed.pointer("/error/code").and_then(Value::as_str);
        let message = parsed.pointer("/error/message").and_then(Value::as_str);
        return Err(Error::Http(match (code, message) {
            (Some(code), Some(message)) => format!("HTTP {} {code}: {message}", response.status),
            _ => format!("HTTP {}: {}", response.status, parsed),
        }));
    }
    Ok(parsed)
}

fn preflight_etag(
    manifest: &Manifest,
    agent: &ureq::Agent,
    runtime: &Runtime<'_>,
    operation: &Operation,
    matches: &ArgMatches,
) -> Result<Option<String>, Error> {
    if !operation.accepts_if_match || matches.get_flag("no-if-match") {
        return Ok(None);
    }
    if let Some(value) = matches.get_one::<String>("if-match") {
        return Ok(Some(value.clone()));
    }
    let preflight_id = operation.preflight_operation_id.as_ref().ok_or_else(|| {
        Error::Usage(format!(
            "{} needs --if-match because no preflight GET is available",
            operation.id
        ))
    })?;
    let preflight = manifest
        .operations
        .iter()
        .find(|candidate| &candidate.id == preflight_id)
        .ok_or_else(|| Error::Manifest(format!("missing preflight operation {preflight_id}")))?;
    let url = build_url(runtime, preflight, matches, None)?;
    let response = send(agent, runtime, preflight, &url, &BTreeMap::new(), None)?;
    ensure_success(&response)?;
    response
        .headers
        .get("etag")
        .cloned()
        .map(Some)
        .ok_or_else(|| Error::Http("preflight GET did not return an ETag".into()))
}

fn write_json_to(writer: &mut impl Write, value: &Value, mode: &str) -> Result<(), Error> {
    match mode {
        "json" => writeln!(writer, "{}", serde_json::to_string_pretty(value)?)?,
        "raw" => match value {
            Value::String(value) => writeln!(writer, "{value}")?,
            _ => writeln!(writer, "{}", serde_json::to_string(value)?)?,
        },
        "jsonl" => {
            let values = value
                .as_array()
                .or_else(|| value.get("items").and_then(Value::as_array))
                .map(Vec::as_slice)
                .unwrap_or(std::slice::from_ref(value));
            for item in values {
                writeln!(writer, "{}", serde_json::to_string(item)?)?;
            }
        }
        "table" => write_table(writer, value)?,
        "csv" => write_csv(writer, value)?,
        _ => unreachable!(),
    }
    Ok(())
}

fn is_broken_pipe(error: &Error) -> bool {
    match error {
        Error::Io(error) => error.kind() == io::ErrorKind::BrokenPipe,
        Error::Csv(error) => {
            matches!(error.kind(), csv::ErrorKind::Io(error) if error.kind() == io::ErrorKind::BrokenPipe)
        }
        _ => false,
    }
}

fn normalize_stdout_result(result: Result<(), Error>) -> Result<(), Error> {
    match result {
        Err(error) if is_broken_pipe(&error) => Ok(()),
        result => result,
    }
}

fn write_json(value: &Value, mode: &str) -> Result<(), Error> {
    let stdout = io::stdout();
    let mut writer = stdout.lock();
    normalize_stdout_result(write_json_to(&mut writer, value, mode))
}

fn output_rows(value: &Value) -> Vec<&Value> {
    value
        .as_array()
        .map(Vec::as_slice)
        .or_else(|| {
            value
                .get("items")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
        })
        .unwrap_or(std::slice::from_ref(value))
        .iter()
        .collect()
}

fn cell(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(value)) => value.clone(),
        Some(value) => serde_json::to_string(value).unwrap_or_default(),
    }
}

fn columns(rows: &[&Value]) -> Vec<String> {
    let mut columns = Vec::new();
    for row in rows {
        if let Some(object) = row.as_object() {
            for name in object.keys() {
                if !columns.contains(name) {
                    columns.push(name.clone());
                }
            }
        }
    }
    columns
}

fn write_table(writer: &mut impl Write, value: &Value) -> Result<(), Error> {
    let rows = output_rows(value);
    let columns = columns(&rows);
    if columns.is_empty() {
        writeln!(writer, "{}", cell(Some(value)))?;
        return Ok(());
    }
    let mut builder = Builder::default();
    builder.push_record(columns.iter().map(|column| column.to_ascii_uppercase()));
    for row in rows {
        builder.push_record(
            columns
                .iter()
                .map(|column| cell(row.get(column)))
                .collect::<Vec<_>>(),
        );
    }
    let mut table = builder.build();
    table.with(Style::rounded());
    writeln!(writer, "{table}")?;
    Ok(())
}

fn write_csv(writer: &mut impl Write, value: &Value) -> Result<(), Error> {
    let rows = output_rows(value);
    let columns = columns(&rows);
    if columns.is_empty() {
        return Err(Error::Usage(
            "--output csv requires an object or an array of objects".into(),
        ));
    }
    let mut writer = csv::Writer::from_writer(writer);
    writer.write_record(&columns)?;
    for row in rows {
        writer.write_record(columns.iter().map(|column| cell(row.get(column))))?;
    }
    writer.flush()?;
    Ok(())
}

fn pagination_spinner() -> ProgressBar {
    let progress = ProgressBar::new_spinner();
    let template = if std::env::var_os("NO_COLOR").is_some() {
        "{spinner} Fetching pages ({pos} items)"
    } else {
        "{spinner:.cyan} Fetching pages ({pos} items)"
    };
    progress.set_style(ProgressStyle::with_template(template).expect("valid progress template"));
    progress.enable_steady_tick(Duration::from_millis(100));
    progress
}

pub fn current_user(manifest: &Manifest, runtime: &Runtime<'_>) -> Result<Value, Error> {
    let agent = ureq::AgentBuilder::new().timeout(runtime.timeout).build();
    let operation = manifest
        .operations
        .iter()
        .find(|operation| operation.id == "me")
        .ok_or_else(|| Error::Manifest("missing me operation".into()))?;
    let url = Url::parse(&format!(
        "{}{}",
        runtime.base_url.trim_end_matches('/'),
        operation.path
    ))?;
    let response = send(&agent, runtime, operation, &url, &BTreeMap::new(), None)?;
    let envelope = ensure_success(&response)?;
    envelope
        .get("data")
        .cloned()
        .ok_or_else(|| Error::Http("response envelope has no data".into()))
}

pub fn execute(
    manifest: &Manifest,
    runtime: &Runtime<'_>,
    operation: &Operation,
    matches: &ArgMatches,
) -> Result<(), Error> {
    if operation.session_only {
        return Err(Error::Usage(format!(
            "{} requires a browser session, which the CLI does not support",
            operation.id
        )));
    }
    let agent = ureq::AgentBuilder::new().timeout(runtime.timeout).build();
    confirm(operation, matches)?;
    let body = request_body(operation, matches)?;
    let if_match = preflight_etag(manifest, &agent, runtime, operation, matches)?;
    let generated_key = operation
        .accepts_idempotency_key
        .then(generated_idempotency_key);
    let idempotency_key = matches
        .try_get_one::<String>("idempotency-key")
        .ok()
        .flatten()
        .map(String::as_str)
        .or(generated_key.as_deref());
    let headers = request_headers(operation, matches, if_match.as_deref(), idempotency_key);

    if operation.paginated && matches.get_flag("all") {
        if runtime.raw_envelope {
            return Err(Error::Usage(
                "--raw-envelope cannot be combined with --all".into(),
            ));
        }
        let mut cursor: Option<String> = None;
        let mut seen_cursors = HashSet::new();
        let mut items = Vec::new();
        let progress = pagination_spinner();
        loop {
            let url = build_url(runtime, operation, matches, cursor.as_deref())?;
            let response = send(&agent, runtime, operation, &url, &headers, body.as_deref())?;
            let envelope = ensure_success(&response)?;
            let data = envelope
                .get("data")
                .ok_or_else(|| Error::Http("response envelope has no data".into()))?;
            let page_items = data
                .get("items")
                .and_then(Value::as_array)
                .ok_or_else(|| Error::Http("paginated response has no items array".into()))?;
            items.extend(page_items.iter().cloned());
            progress.set_position(items.len() as u64);
            cursor = data
                .get("next_cursor")
                .and_then(Value::as_str)
                .map(str::to_owned);
            match cursor.as_ref() {
                None => break,
                Some(cursor) if !seen_cursors.insert(cursor.clone()) => {
                    return Err(Error::Http("server repeated a pagination cursor".into()));
                }
                Some(_) => {}
            }
        }
        progress.finish_and_clear();
        return write_json(&Value::Array(items), runtime.output);
    }

    let url = build_url(runtime, operation, matches, None)?;
    let response = send(&agent, runtime, operation, &url, &headers, body.as_deref())?;
    if operation.response_kind == ResponseKind::Raw && (200..300).contains(&response.status) {
        let stdout = io::stdout();
        let mut writer = stdout.lock();
        return normalize_stdout_result(writer.write_all(&response.body).map_err(Error::from));
    }
    let envelope = ensure_success(&response)?;
    let value = if runtime.raw_envelope {
        &envelope
    } else {
        envelope.get("data").unwrap_or(&envelope)
    };
    write_json(value, runtime.output)
}

#[cfg(test)]
mod tests {
    use std::io::{self, BufRead, BufReader};
    use std::net::TcpListener;

    use super::*;

    struct BrokenPipeWriter;

    impl Write for BrokenPipeWriter {
        fn write(&mut self, _buffer: &[u8]) -> io::Result<usize> {
            Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed pipe"))
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn operation<'a>(manifest: &'a Manifest, id: &str) -> &'a Operation {
        manifest
            .operations
            .iter()
            .find(|operation| operation.id == id)
            .expect("operation exists")
    }

    fn serve_once(status: u16, body: &str) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let address = listener.local_addr().expect("test server address");
        let body = body.to_owned();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            let mut request = [0; 4096];
            let length = stream.read(&mut request).expect("read request");
            let request = String::from_utf8_lossy(&request[..length]);
            assert!(request.starts_with("GET /api/v1/me HTTP/1.1"));
            assert!(request
                .to_ascii_lowercase()
                .contains("authorization: bearer mhub_pat_test"));
            write!(
                stream,
                "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .expect("write response");
        });
        (format!("http://{address}"), handle)
    }

    fn serve_twice_on_one_connection(body: &str) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let address = listener.local_addr().expect("test server address");
        let body = body.to_owned();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            let mut reader = BufReader::new(stream.try_clone().expect("clone test stream"));
            for _ in 0..2 {
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).expect("read request line");
                    if line == "\r\n" {
                        break;
                    }
                }
                write!(
					stream,
					"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
					body.len(),
				)
                .expect("write response");
                stream.flush().expect("flush response");
            }
        });
        (format!("http://{address}"), handle)
    }

    #[test]
    fn current_user_validates_the_token_with_me() {
        let (base_url, server) = serve_once(
            200,
            r#"{"success":true,"data":{"id":"user-1","email":"user@example.com"}}"#,
        );
        let token = SecretString::from("mhub_pat_test".to_owned());
        let runtime = Runtime {
            base_url: &base_url,
            token: Some(&token),
            timeout: Duration::from_secs(1),
            output: "json",
            raw_envelope: false,
        };

        let user = current_user(&crate::manifest::load(), &runtime).expect("valid token");
        server.join().expect("test server");
        assert_eq!(user["email"], "user@example.com");
    }

    #[test]
    fn current_user_rejects_an_invalid_token() {
        let (base_url, server) = serve_once(
            401,
            r#"{"success":false,"error":{"code":"UNAUTHORIZED","message":"Authentication required"}}"#,
        );
        let token = SecretString::from("mhub_pat_test".to_owned());
        let runtime = Runtime {
            base_url: &base_url,
            token: Some(&token),
            timeout: Duration::from_secs(1),
            output: "json",
            raw_envelope: false,
        };

        let error = current_user(&crate::manifest::load(), &runtime).expect_err("invalid token");
        server.join().expect("test server");
        assert!(matches!(error, Error::Http(message) if message.contains("HTTP 401 UNAUTHORIZED")));
    }

    #[test]
    fn agent_reuses_a_connection_across_requests() {
        let (base_url, server) =
            serve_twice_on_one_connection(r#"{"success":true,"data":{"enabled":true}}"#);
        let manifest = crate::manifest::load();
        let operation = operation(&manifest, "capabilities");
        let runtime = Runtime {
            base_url: &base_url,
            token: None,
            timeout: Duration::from_secs(1),
            output: "json",
            raw_envelope: false,
        };
        let agent = ureq::AgentBuilder::new().timeout(runtime.timeout).build();
        let url = Url::parse(&format!("{base_url}{}", operation.path)).expect("valid URL");

        for _ in 0..2 {
            let response = send(&agent, &runtime, operation, &url, &BTreeMap::new(), None)
                .expect("request succeeds");
            ensure_success(&response).expect("successful response");
        }

        server.join().expect("test server");
    }

    #[test]
    fn typed_flags_build_a_json_body() {
        let manifest = crate::manifest::load();
        let matches = crate::cli::build(&manifest)
            .try_get_matches_from([
                "mohub",
                "projects",
                "create",
                "--name",
                "Analysis",
                "--description",
                "Models",
                "--tags",
                "one",
                "--tags",
                "two",
            ])
            .expect("valid command");
        let leaf = matches
            .subcommand_matches("projects")
            .and_then(|matches| matches.subcommand_matches("create"))
            .expect("projects create matches");
        let body = request_body(operation(&manifest, "projects.create"), leaf)
            .expect("valid body")
            .expect("body present");
        let value: Value = serde_json::from_slice(&body).expect("JSON body");
        assert_eq!(value["name"], "Analysis");
        assert_eq!(value["tags"], serde_json::json!(["one", "two"]));
    }

    #[test]
    fn path_and_query_values_are_url_encoded() {
        let manifest = crate::manifest::load();
        let matches = crate::cli::build(&manifest)
            .try_get_matches_from([
                "mohub",
                "users",
                "search",
                "--q",
                "Ada Lovelace",
                "--limit",
                "5",
            ])
            .expect("valid command");
        let leaf = matches
            .subcommand_matches("users")
            .and_then(|matches| matches.subcommand_matches("search"))
            .expect("users search matches");
        let runtime = Runtime {
            base_url: "https://hub.example.com/",
            token: None,
            timeout: Duration::from_secs(1),
            output: "json",
            raw_envelope: false,
        };
        let url = build_url(&runtime, operation(&manifest, "users.search"), leaf, None)
            .expect("valid URL");
        assert_eq!(
            url.as_str(),
            "https://hub.example.com/api/v1/users/search?limit=5&q=Ada+Lovelace"
        );
    }

    #[test]
    fn table_columns_follow_first_seen_order() {
        let value = serde_json::json!([
            {"id": "one", "name": "First"},
            {"id": "two", "email": "two@example.com"}
        ]);
        let rows = output_rows(&value);

        assert_eq!(columns(&rows), ["id", "name", "email"]);
    }

    #[test]
    fn output_modes_return_broken_pipe_errors_without_panicking() {
        let value = serde_json::json!({"id": "one"});

        for mode in ["json", "raw", "jsonl", "table", "csv"] {
            let error = write_json_to(&mut BrokenPipeWriter, &value, mode)
                .expect_err("closed output should return an error");
            assert!(is_broken_pipe(&error), "unexpected {mode} error: {error}");
            assert!(normalize_stdout_result(Err(error)).is_ok());
        }
    }

    #[test]
    fn session_only_operations_are_rejected_before_http() {
        let manifest = crate::manifest::load();
        let matches = crate::cli::build(&manifest)
            .try_get_matches_from(["mohub", "auth", "tokens", "list"])
            .expect("valid command");
        let leaf = matches
            .subcommand_matches("auth")
            .and_then(|matches| matches.subcommand_matches("tokens"))
            .and_then(|matches| matches.subcommand_matches("list"))
            .expect("auth tokens list matches");
        let runtime = Runtime {
            base_url: "http://127.0.0.1:9",
            token: None,
            timeout: Duration::from_secs(1),
            output: "json",
            raw_envelope: false,
        };

        let error = execute(
            &manifest,
            &runtime,
            operation(&manifest, "auth.tokens.list"),
            leaf,
        )
        .expect_err("session-only operation should be rejected locally");

        assert!(matches!(
            error,
            Error::Usage(message)
                if message.contains("requires a browser session")
        ));
    }
}
