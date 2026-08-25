use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{self, IsTerminal, Read, Write};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use clap::ArgMatches;
use indicatif::{ProgressBar, ProgressStyle};
use inquire::Confirm;
use secrecy::{ExposeSecret, SecretString};
use serde::de::DeserializeOwned;
use serde::Deserialize;
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NotebookDeploymentState {
    pub title: String,
    pub description: String,
    pub tags: Vec<String>,
    pub readme: Option<String>,
    pub base_image: Option<String>,
    pub compute_profile: Option<String>,
    pub source_type: String,
    pub code: String,
    pub etag: String,
}

pub struct Runtime<'a> {
    pub base_url: &'a str,
    pub token: Option<&'a SecretString>,
    pub timeout: Duration,
    pub output: &'a str,
    pub raw_envelope: bool,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
pub struct CliDeviceAuthorization {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(Deserialize)]
struct CliToken {
    token: String,
}

#[derive(Debug)]
pub enum CliDevicePoll {
    Pending,
    Approved(SecretString),
}

fn cli_runtime(base_url: &str, timeout: Duration) -> Runtime<'_> {
    Runtime {
        base_url,
        token: None,
        timeout,
        output: "json",
        raw_envelope: false,
    }
}

fn values(matches: &ArgMatches, id: &str, repeatable: bool) -> Vec<String> {
    if repeatable {
        matches
            .try_get_many::<String>(id)
            .ok()
            .flatten()
            .map(|items| items.cloned().collect())
            .unwrap_or_default()
    } else {
        matches
            .try_get_one::<String>(id)
            .ok()
            .flatten()
            .cloned()
            .into_iter()
            .collect()
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
    send_with_retry(
        agent,
        runtime,
        &operation.method,
        url,
        headers,
        body,
        retryable,
    )
}

fn send_with_retry(
    agent: &ureq::Agent,
    runtime: &Runtime<'_>,
    method: &str,
    url: &Url,
    headers: &BTreeMap<String, String>,
    body: Option<&[u8]>,
    retryable: bool,
) -> Result<HttpResponse, Error> {
    for attempt in 0..3 {
        match send_once(agent, runtime, method, url, headers, body) {
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

pub fn write_output(value: &Value, mode: &str) -> Result<(), Error> {
    write_json(value, mode)
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

fn notebook_url(runtime: &Runtime<'_>, project_id: &str, notebook_id: &str) -> Result<Url, Error> {
    Url::parse(&format!(
        "{}/api/v1/projects/{}/notebooks/{}",
        runtime.base_url.trim_end_matches('/'),
        urlencoding::encode(project_id),
        urlencoding::encode(notebook_id),
    ))
    .map_err(Into::into)
}

fn required_string(value: &Value, pointer: &str, label: &str) -> Result<String, Error> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| Error::Http(format!("notebook response has no valid {label}")))
}

fn optional_string(value: &Value, pointer: &str, label: &str) -> Result<Option<String>, Error> {
    match value.pointer(pointer) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(Error::Http(format!(
            "notebook response has no valid {label}"
        ))),
    }
}

pub fn notebook_deployment_state(
    runtime: &Runtime<'_>,
    project_id: &str,
    notebook_id: &str,
) -> Result<NotebookDeploymentState, Error> {
    let agent = ureq::AgentBuilder::new().timeout(runtime.timeout).build();
    let url = notebook_url(runtime, project_id, notebook_id)?;
    let detail_response =
        send_with_retry(&agent, runtime, "GET", &url, &BTreeMap::new(), None, true)?;
    let detail = ensure_success(&detail_response)?;
    let etag = detail_response
        .headers
        .get("etag")
        .cloned()
        .ok_or_else(|| Error::Http("notebook detail response did not return an ETag".into()))?;
    let data = detail
        .get("data")
        .ok_or_else(|| Error::Http("notebook detail response has no data".into()))?;
    let tags = data
        .pointer("/meta/tags")
        .and_then(Value::as_array)
        .ok_or_else(|| Error::Http("notebook response has no valid tags".into()))?
        .iter()
        .map(|tag| {
            tag.as_str()
                .map(str::to_owned)
                .ok_or_else(|| Error::Http("notebook response has no valid tags".into()))
        })
        .collect::<Result<Vec<_>, _>>()?;

    let content_url = Url::parse(&format!("{}/content", url.as_str().trim_end_matches('/')))?;
    let content_response = send_with_retry(
        &agent,
        runtime,
        "GET",
        &content_url,
        &BTreeMap::new(),
        None,
        true,
    )?;
    let content = ensure_success(&content_response)?;

    Ok(NotebookDeploymentState {
        title: required_string(data, "/meta/title", "title")?,
        description: required_string(data, "/meta/description", "description")?,
        tags,
        readme: optional_string(data, "/readme", "readme")?,
        base_image: optional_string(data, "/meta/base_image", "base_image")?,
        compute_profile: optional_string(data, "/meta/compute_profile", "compute_profile")?,
        source_type: required_string(data, "/source/type", "source type")?,
        code: required_string(&content, "/data/code", "code")?,
        etag,
    })
}

pub fn update_notebook_deployment(
    runtime: &Runtime<'_>,
    project_id: &str,
    notebook_id: &str,
    etag: &str,
    body: &Value,
) -> Result<Value, Error> {
    let agent = ureq::AgentBuilder::new().timeout(runtime.timeout).build();
    let url = notebook_url(runtime, project_id, notebook_id)?;
    let headers = BTreeMap::from([("If-Match".to_owned(), etag.to_owned())]);
    let bytes = serde_json::to_vec(body)?;
    let response = send_with_retry(
        &agent,
        runtime,
        "PATCH",
        &url,
        &headers,
        Some(&bytes),
        false,
    )?;
    let envelope = ensure_success(&response)?;
    envelope
        .get("data")
        .cloned()
        .ok_or_else(|| Error::Http("notebook update response has no data".into()))
}

fn post_cli_json(
    base_url: &str,
    timeout: Duration,
    path: &str,
    body: Value,
) -> Result<(u16, Value), Error> {
    let url = Url::parse(&format!("{}{}", base_url.trim_end_matches('/'), path))?;
    let body = serde_json::to_vec(&body)?;
    let runtime = cli_runtime(base_url, timeout);
    let agent = ureq::AgentBuilder::new().timeout(timeout).build();
    let response = send_once(
        &agent,
        &runtime,
        "POST",
        &url,
        &BTreeMap::new(),
        Some(&body),
    )?;
    let status = response.status;
    Ok((status, ensure_success(&response)?))
}

fn cli_data<T: DeserializeOwned>(envelope: &Value, operation: &str) -> Result<T, Error> {
    let data = envelope
        .get("data")
        .cloned()
        .ok_or_else(|| Error::Http(format!("{operation} response has no data")))?;
    serde_json::from_value(data)
        .map_err(|error| Error::Http(format!("{operation} response has invalid data: {error}")))
}

fn expect_cli_status(status: u16, expected: u16, operation: &str) -> Result<(), Error> {
    if status == expected {
        Ok(())
    } else {
        Err(Error::Http(format!(
            "{operation} returned unexpected HTTP {status}"
        )))
    }
}

pub fn exchange_cli_authorization(
    base_url: &str,
    timeout: Duration,
    code: &str,
    code_verifier: &str,
) -> Result<SecretString, Error> {
    let (status, envelope) = post_cli_json(
        base_url,
        timeout,
        "/api/cli/v1/token",
        serde_json::json!({ "code": code, "code_verifier": code_verifier }),
    )?;
    expect_cli_status(status, 200, "CLI token exchange")?;
    let response: CliToken = cli_data(&envelope, "CLI token exchange")?;
    if response.token.is_empty() {
        return Err(Error::Http("CLI token exchange returned no token".into()));
    }
    Ok(SecretString::from(response.token))
}

pub fn request_cli_device_authorization(
    base_url: &str,
    timeout: Duration,
    code_challenge: &str,
) -> Result<CliDeviceAuthorization, Error> {
    let (status, envelope) = post_cli_json(
        base_url,
        timeout,
        "/api/cli/v1/device-authorizations",
        serde_json::json!({ "code_challenge": code_challenge }),
    )?;
    expect_cli_status(status, 200, "CLI device authorization")?;
    let response: CliDeviceAuthorization = cli_data(&envelope, "CLI device authorization")?;
    if response.device_code.is_empty()
        || response.user_code.is_empty()
        || response.verification_uri.is_empty()
        || response.expires_in == 0
        || response.interval == 0
    {
        return Err(Error::Http(
            "CLI device authorization response has invalid data".into(),
        ));
    }
    Ok(response)
}

pub fn poll_cli_device_authorization(
    base_url: &str,
    timeout: Duration,
    device_code: &str,
    code_verifier: &str,
) -> Result<CliDevicePoll, Error> {
    let (status, envelope) = post_cli_json(
        base_url,
        timeout,
        "/api/cli/v1/device-token",
        serde_json::json!({ "device_code": device_code, "code_verifier": code_verifier }),
    )?;
    match status {
        202 => {
            if envelope.pointer("/data/status").and_then(Value::as_str)
                != Some("authorization_pending")
            {
                return Err(Error::Http(
                    "CLI device poll response has invalid pending status".into(),
                ));
            }
            Ok(CliDevicePoll::Pending)
        }
        200 => {
            let response: CliToken = cli_data(&envelope, "CLI device poll")?;
            if response.token.is_empty() {
                return Err(Error::Http("CLI device poll returned no token".into()));
            }
            Ok(CliDevicePoll::Approved(SecretString::from(response.token)))
        }
        _ => Err(Error::Http(format!(
            "CLI device poll returned unexpected HTTP {status}"
        ))),
    }
}

pub fn execute(
    manifest: &Manifest,
    runtime: &Runtime<'_>,
    operation: &Operation,
    matches: &ArgMatches,
) -> Result<(), Error> {
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

    fn serve_cli_exchange(body: &str) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let address = listener.local_addr().expect("test server address");
        let body = body.to_owned();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            let mut reader = BufReader::new(stream.try_clone().expect("clone test stream"));
            let mut request = String::new();
            let mut content_length = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).expect("read request header");
                assert!(!line.is_empty(), "request ended before its headers");
                if let Some((name, value)) = line.split_once(':') {
                    if name.eq_ignore_ascii_case("content-length") {
                        content_length = value.trim().parse().expect("numeric content length");
                    }
                }
                request.push_str(&line);
                if line == "\r\n" {
                    break;
                }
            }
            let mut request_body = vec![0; content_length];
            reader
                .read_exact(&mut request_body)
                .expect("read request body");
            request.push_str(std::str::from_utf8(&request_body).expect("UTF-8 request body"));
            assert!(request.starts_with("POST /api/cli/v1/token HTTP/1.1"));
            assert!(!request.to_ascii_lowercase().contains("authorization:"));
            assert!(request.contains(r#""code":"mhub_cli_code""#));
            assert!(request.contains(r#""code_verifier":"verifier""#));
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .expect("write response");
        });
        (format!("http://{address}"), handle)
    }

    fn serve_cli_device(
        path: &str,
        status: u16,
        body: &str,
        expected_body: &str,
    ) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let address = listener.local_addr().expect("test server address");
        let path = path.to_owned();
        let body = body.to_owned();
        let expected_body = expected_body.to_owned();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            let mut reader = BufReader::new(stream.try_clone().expect("clone test stream"));
            let mut request = String::new();
            let mut content_length = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).expect("read request header");
                assert!(!line.is_empty(), "request ended before its headers");
                if let Some((name, value)) = line.split_once(':') {
                    if name.eq_ignore_ascii_case("content-length") {
                        content_length = value.trim().parse().expect("numeric content length");
                    }
                }
                request.push_str(&line);
                if line == "\r\n" {
                    break;
                }
            }
            let mut request_body = vec![0; content_length];
            reader
                .read_exact(&mut request_body)
                .expect("read request body");
            request.push_str(std::str::from_utf8(&request_body).expect("UTF-8 request body"));
            assert!(request.starts_with(&format!("POST {path} HTTP/1.1")));
            assert!(!request.to_ascii_lowercase().contains("authorization:"));
            assert!(request.contains(&expected_body));
            write!(
                stream,
                "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .expect("write response");
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
    fn cli_authorization_exchange_returns_the_one_time_token() {
        let (base_url, server) =
            serve_cli_exchange(r#"{"success":true,"data":{"token":"mhub_pat_returned"}}"#);

        let token = exchange_cli_authorization(
            &base_url,
            Duration::from_secs(1),
            "mhub_cli_code",
            "verifier",
        )
        .expect("exchange succeeds");

        server.join().expect("test server");
        assert_eq!(token.expose_secret(), "mhub_pat_returned");
    }

    #[test]
    fn cli_device_authorization_parses_the_verification_instructions() {
        let (base_url, server) = serve_cli_device(
            "/api/cli/v1/device-authorizations",
            200,
            r#"{"success":true,"data":{"device_code":"mhub_cli_device","user_code":"WDJB-MJHT","verification_uri":"https://hub.example.com/cli/device","verification_uri_complete":"https://hub.example.com/cli/device?user_code=WDJB-MJHT","expires_in":600,"interval":5}}"#,
            r#""code_challenge":"challenge""#,
        );

        let authorization =
            request_cli_device_authorization(&base_url, Duration::from_secs(1), "challenge")
                .expect("request succeeds");

        server.join().expect("test server");
        assert_eq!(authorization.device_code, "mhub_cli_device");
        assert_eq!(authorization.user_code, "WDJB-MJHT");
        assert_eq!(authorization.expires_in, 600);
        assert_eq!(authorization.interval, 5);
    }

    #[test]
    fn cli_device_poll_distinguishes_pending_and_approved() {
        let (base_url, pending_server) = serve_cli_device(
            "/api/cli/v1/device-token",
            202,
            r#"{"success":true,"data":{"status":"authorization_pending"}}"#,
            r#""device_code":"mhub_cli_device""#,
        );
        assert!(matches!(
            poll_cli_device_authorization(
                &base_url,
                Duration::from_secs(1),
                "mhub_cli_device",
                "verifier",
            )
            .expect("pending poll succeeds"),
            CliDevicePoll::Pending
        ));
        pending_server.join().expect("pending test server");

        let (base_url, approved_server) = serve_cli_device(
            "/api/cli/v1/device-token",
            200,
            r#"{"success":true,"data":{"token":"mhub_pat_returned"}}"#,
            r#""code_verifier":"verifier""#,
        );
        let result = poll_cli_device_authorization(
            &base_url,
            Duration::from_secs(1),
            "mhub_cli_device",
            "verifier",
        )
        .expect("approved poll succeeds");
        approved_server.join().expect("approved test server");
        match result {
            CliDevicePoll::Approved(token) => {
                assert_eq!(token.expose_secret(), "mhub_pat_returned");
            }
            CliDevicePoll::Pending => panic!("expected approved device authorization"),
        }
    }

    #[test]
    fn cli_device_authorization_rejects_incomplete_or_invalid_data() {
        for body in [
            r#"{"success":true}"#,
            r#"{"success":true,"data":{"device_code":"","user_code":"WDJB-MJHT","verification_uri":"https://hub.example.com/cli/device","expires_in":600,"interval":5}}"#,
            r#"{"success":true,"data":{"device_code":"mhub_cli_device","user_code":"WDJB-MJHT","verification_uri":"https://hub.example.com/cli/device","expires_in":0,"interval":5}}"#,
            r#"{"success":true,"data":{"device_code":"mhub_cli_device","user_code":"WDJB-MJHT","verification_uri":"https://hub.example.com/cli/device","expires_in":"600","interval":5}}"#,
        ] {
            let (base_url, server) = serve_cli_device(
                "/api/cli/v1/device-authorizations",
                200,
                body,
                r#""code_challenge":"challenge""#,
            );

            let error =
                request_cli_device_authorization(&base_url, Duration::from_secs(1), "challenge")
                    .expect_err("invalid response must fail");
            server.join().expect("test server");
            assert!(matches!(error, Error::Http(_)));
        }
    }

    #[test]
    fn cli_device_poll_rejects_malformed_status_and_token_responses() {
        for (status, body, expected) in [
            (
                202,
                r#"{"success":true,"data":{"status":"approved"}}"#,
                "invalid pending status",
            ),
            (
                200,
                r#"{"success":true,"data":{"token":""}}"#,
                "returned no token",
            ),
            (
                201,
                r#"{"success":true,"data":{"token":"mhub_pat_returned"}}"#,
                "unexpected HTTP 201",
            ),
        ] {
            let (base_url, server) = serve_cli_device(
                "/api/cli/v1/device-token",
                status,
                body,
                r#""device_code":"mhub_cli_device""#,
            );

            let error = poll_cli_device_authorization(
                &base_url,
                Duration::from_secs(1),
                "mhub_cli_device",
                "verifier",
            )
            .expect_err("invalid response must fail");
            server.join().expect("test server");
            assert!(error.to_string().contains(expected), "{error}");
        }
    }

    #[test]
    fn cli_token_exchange_rejects_missing_tokens_and_unexpected_statuses() {
        for (status, body, expected) in [
            (200, r#"{"success":true,"data":{}}"#, "invalid data"),
            (
                202,
                r#"{"success":true,"data":{"token":"mhub_pat_returned"}}"#,
                "unexpected HTTP 202",
            ),
        ] {
            let (base_url, server) = serve_cli_device(
                "/api/cli/v1/token",
                status,
                body,
                r#""code":"mhub_cli_code""#,
            );

            let error = exchange_cli_authorization(
                &base_url,
                Duration::from_secs(1),
                "mhub_cli_code",
                "verifier",
            )
            .expect_err("invalid response must fail");
            server.join().expect("test server");
            assert!(error.to_string().contains(expected), "{error}");
        }
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
    fn annotated_scalar_body_flags_remain_strings() {
        let manifest = crate::manifest::load();
        let matches = crate::cli::build(&manifest)
            .try_get_matches_from([
                "mohub",
                "projects",
                "members",
                "update",
                "--pid",
                "proj-7h2k9qm4xz7rp3w8",
                "--uid",
                "user-1",
                "--role",
                "manager",
            ])
            .expect("valid command");
        let leaf = matches
            .subcommand_matches("projects")
            .and_then(|matches| matches.subcommand_matches("members"))
            .and_then(|matches| matches.subcommand_matches("update"))
            .expect("project member update matches");
        let body = request_body(operation(&manifest, "projects.members.update"), leaf)
            .expect("valid body")
            .expect("body present");

        assert_eq!(
            serde_json::from_slice::<Value>(&body).expect("JSON body"),
            serde_json::json!({ "role": "manager" })
        );
    }

    #[test]
    fn values_ignores_ids_missing_from_preflight_matches() {
        let matches = clap::Command::new("test")
            .try_get_matches_from(["test"])
            .expect("valid command");

        assert!(values(&matches, "parameter:cursor", false).is_empty());
        assert!(values(&matches, "parameter:tag", true).is_empty());
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
}
