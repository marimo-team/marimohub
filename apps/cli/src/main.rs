use std::fs;
use std::io::{self, IsTerminal, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::process::{Command, ExitCode};
use std::thread;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use clap::ArgMatches;
use mohub::{cli, client, config, deploy, manifest, Error};
use secrecy::SecretString;
use sha2::{Digest, Sha256};
use update_informer::{registry, Check};
use url::Url;

const CLI_LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);

fn write_stdout(arguments: std::fmt::Arguments<'_>) -> Result<(), Error> {
    match io::stdout().lock().write_fmt(arguments) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::BrokenPipe => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn selected_command(matches: &ArgMatches) -> (Vec<String>, &ArgMatches) {
    let mut path = Vec::new();
    let mut current = matches;
    while let Some((name, child)) = current.subcommand() {
        path.push(name.to_owned());
        current = child;
    }
    (path, current)
}

fn supplied_token(matches: &ArgMatches) -> Result<Option<SecretString>, Error> {
    let token_stdin = matches
        .try_get_one::<bool>("token-stdin")
        .ok()
        .flatten()
        .copied()
        .unwrap_or(false);
    if token_stdin {
        return config::read_token(io::stdin()).map(Some);
    }
    if let Some(token) = matches.get_one::<String>("token") {
        let token = token.trim();
        if token.is_empty() {
            return Err(Error::Config("token cannot be empty".into()));
        }
        return Ok(Some(SecretString::from(token.to_owned())));
    }
    if let Some(path) = matches.get_one::<String>("token-file") {
        return config::read_token(fs::File::open(path)?).map(Some);
    }
    Ok(None)
}

fn handle_profile(matches: &ArgMatches) -> Result<(), Error> {
    match matches.subcommand() {
        Some(("list", _)) => {
            let config = config::load()?;
            for (name, profile) in &config.profiles {
                let marker = if config.current_profile.as_deref() == Some(name) {
                    "*"
                } else {
                    " "
                };
                write_stdout(format_args!("{marker} {name}\t{}\n", profile.base_url))?;
            }
        }
        Some(("set", args)) => {
            let token = supplied_token(args)?;
            let name = args.get_one::<String>("name").expect("required by clap");
            let base_url = args
                .get_one::<String>("base-url")
                .expect("required by clap");
            let base_url = normalize_base_url(base_url)?;
            config::set_profile(name, base_url, token.as_ref())?;
        }
        Some(("use", args)) => {
            let name = args.get_one::<String>("name").expect("required by clap");
            config::update(|config| {
                if !config.profiles.contains_key(name) {
                    return Err(Error::Config(format!("profile {name:?} does not exist")));
                }
                config.current_profile = Some(name.clone());
                Ok(())
            })?;
        }
        Some(("remove", args)) => {
            let name = args.get_one::<String>("name").expect("required by clap");
            config::remove_profile(name)?;
        }
        _ => unreachable!("profile subcommand required by clap"),
    }
    Ok(())
}

fn normalize_base_url(value: &str) -> Result<String, Error> {
    config::normalize_base_url(value)
}

fn server_label(value: &str) -> String {
    url::Url::parse(value)
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or_else(|_| "the configured server".into())
}

fn matching_server(override_url: Option<&str>, profile_url: Option<&str>) -> Result<bool, Error> {
    match (override_url, profile_url) {
        (Some(override_url), Some(profile_url)) => {
            Ok(normalize_base_url(override_url)? == normalize_base_url(profile_url)?)
        }
        _ => Ok(true),
    }
}

fn stored_token_for_server(
    profile_name: &str,
    override_url: Option<&str>,
    profile_url: Option<&str>,
    token: Option<SecretString>,
) -> Result<Option<SecretString>, Error> {
    if token.is_some() && !matching_server(override_url, profile_url)? {
        return Err(Error::Usage(format!(
			"refusing to send the stored token for profile {profile_name:?} to a different server; pass --token or --token-file explicitly"
		)));
    }
    Ok(token)
}

fn selected_profile(matches: &ArgMatches) -> Result<(String, String), Error> {
    let config = config::load()?;
    let name = matches
        .get_one::<String>("profile-name")
        .cloned()
        .or(config.current_profile)
        .ok_or_else(|| {
            Error::Config(
                "no profile selected; create one with `mohub profile set NAME --base-url URL`"
                    .into(),
            )
        })?;
    let profile = config
        .profiles
        .get(&name)
        .ok_or_else(|| Error::Config(format!("profile {name:?} does not exist")))?;
    let profile_url = normalize_base_url(&profile.base_url)?;
    require_matching_profile_server(matches, &name, &profile_url)?;
    Ok((name, profile_url))
}

fn require_matching_profile_server(
    matches: &ArgMatches,
    name: &str,
    profile_url: &str,
) -> Result<(), Error> {
    if !matching_server(
        matches.get_one::<String>("base-url").map(String::as_str),
        Some(profile_url),
    )? {
        return Err(Error::Usage(format!(
			"server override does not match profile {name:?}; update the profile or select a matching one"
		)));
    }
    Ok(())
}

fn auth_runtime<'a>(
    matches: &'a ArgMatches,
    base_url: &'a str,
    token: &'a SecretString,
) -> client::Runtime<'a> {
    client::Runtime {
        base_url,
        token: Some(token),
        timeout: Duration::from_secs(
            *matches
                .get_one::<u64>("timeout")
                .expect("defaulted by clap"),
        ),
        output: matches
            .get_one::<String>("output")
            .expect("defaulted by clap"),
        raw_envelope: matches.get_flag("raw-envelope"),
    }
}

fn user_label(user: &serde_json::Value) -> &str {
    user.get("email")
        .and_then(serde_json::Value::as_str)
        .or_else(|| user.get("id").and_then(serde_json::Value::as_str))
        .unwrap_or("unknown user")
}

fn random_base64url(byte_length: usize) -> Result<String, Error> {
    let mut bytes = vec![0_u8; byte_length];
    getrandom::fill(&mut bytes).map_err(|error| {
        Error::Config(format!("could not generate secure random data: {error}"))
    })?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn browser_login_origin(base_url: &str) -> Result<Url, Error> {
    let url = Url::parse(base_url)?;
    if url.path() != "/" {
        return Err(Error::Usage(
            "browser login requires a Hub URL without a path; use `mohub login --token-stdin` for a path-prefixed deployment"
                .into(),
        ));
    }
    Ok(url)
}

fn cli_login_url(
    base_url: &str,
    callback_uri: &str,
    state: &str,
    code_challenge: &str,
) -> Result<Url, Error> {
    let mut url = browser_login_origin(base_url)?;
    url.set_path("/cli/login");
    url.set_query(None);
    url.set_fragment(None);
    url.query_pairs_mut()
        .append_pair("callback_uri", callback_uri)
        .append_pair("state", state)
        .append_pair("code_challenge", code_challenge);
    Ok(url)
}

fn open_browser(url: &str) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg(url).status()?;
    #[cfg(target_os = "windows")]
    let status = Command::new("explorer.exe").arg(url).status()?;
    #[cfg(all(unix, not(target_os = "macos")))]
    let status = Command::new("xdg-open").arg(url).status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other(
            "browser launcher returned a failure status",
        ))
    }
}

fn callback_response(stream: &mut TcpStream, success: bool) -> io::Result<()> {
    let (status, title, message) = if success {
        (
            "200 OK",
            "CLI connected",
            "You are signed in. You can close this tab and return to your terminal.",
        )
    } else {
        (
            "400 Bad Request",
            "CLI sign-in failed",
            "Return to your terminal for details, then run mohub login again.",
        )
    };
    let body = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>{title}</title><style>body{{font:16px system-ui;display:grid;min-height:100vh;place-items:center;margin:0;background:#f7f7f8;color:#18181b}}main{{max-width:32rem;padding:2rem;text-align:center}}h1{{font-size:1.4rem}}p{{color:#52525b;line-height:1.5}}</style></head><body><main><h1>{title}</h1><p>{message}</p></main></body></html>"
    );
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n{body}",
        body.len(),
    )?;
    stream.flush()
}

fn read_callback_request(stream: &mut TcpStream) -> io::Result<String> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut request = Vec::with_capacity(1024);
    let mut chunk = [0_u8; 1024];
    loop {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        request.extend_from_slice(&chunk[..read]);
        if request.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        if request.len() >= 8192 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "callback request headers are too large",
            ));
        }
    }
    String::from_utf8(request)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "callback request is not UTF-8"))
}

struct AuthorizationCallback {
    stream: TcpStream,
    code: String,
}

struct BrowserCredential {
    token: SecretString,
    callback: TcpStream,
}

fn wait_for_authorization(
    listener: &TcpListener,
    expected_state: &str,
) -> Result<AuthorizationCallback, Error> {
    listener.set_nonblocking(true)?;
    let deadline = Instant::now() + CLI_LOGIN_TIMEOUT;
    while Instant::now() < deadline {
        let (mut stream, _) = match listener.accept() {
            Ok(connection) => connection,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(100));
                continue;
            }
            Err(error) => return Err(error.into()),
        };
        let request = match read_callback_request(&mut stream) {
            Ok(request) => request,
            Err(_) => {
                let _ = callback_response(&mut stream, false);
                continue;
            }
        };
        let Some(request_line) = request.lines().next() else {
            let _ = callback_response(&mut stream, false);
            continue;
        };
        let mut parts = request_line.split_whitespace();
        let method = parts.next();
        let target = parts.next();
        if method != Some("GET") {
            let _ = callback_response(&mut stream, false);
            continue;
        }
        let Some(target) = target else {
            let _ = callback_response(&mut stream, false);
            continue;
        };
        let Ok(url) = Url::parse(&format!("http://127.0.0.1{target}")) else {
            let _ = callback_response(&mut stream, false);
            continue;
        };
        if url.path() != "/callback"
            || url
                .query_pairs()
                .find(|(name, _)| name == "state")
                .is_none_or(|(_, state)| state != expected_state)
        {
            let _ = callback_response(&mut stream, false);
            continue;
        }
        let parameters = url
            .query_pairs()
            .collect::<std::collections::BTreeMap<_, _>>();
        if parameters.get("error").map(|value| value.as_ref()) == Some("access_denied") {
            let _ = callback_response(&mut stream, false);
            return Err(Error::Cancelled);
        }
        let Some(code) = parameters.get("code").filter(|code| !code.is_empty()) else {
            let _ = callback_response(&mut stream, false);
            continue;
        };
        return Ok(AuthorizationCallback {
            stream,
            code: code.to_string(),
        });
    }
    Err(Error::Authentication {
        server: "the configured server".into(),
        reason: "browser sign-in timed out".into(),
    })
}

fn browser_login(
    matches: &ArgMatches,
    base_url: &str,
    no_browser: bool,
) -> Result<BrowserCredential, Error> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let callback_uri = format!("http://{}/callback", listener.local_addr()?);
    let state = random_base64url(24)?;
    let code_verifier = random_base64url(32)?;
    let code_challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(code_verifier.as_bytes()));
    let login_url = cli_login_url(base_url, &callback_uri, &state, &code_challenge)?;

    if no_browser || open_browser(login_url.as_str()).is_err() {
        eprintln!("Open this URL to sign in:\n\n{login_url}\n");
    } else {
        eprintln!("Opening {base_url} in your browser…");
    }
    eprintln!("Waiting for approval…");

    let mut callback = wait_for_authorization(&listener, &state)?;
    let timeout = Duration::from_secs(
        *matches
            .get_one::<u64>("timeout")
            .expect("defaulted by clap"),
    );
    match client::exchange_cli_authorization(base_url, timeout, &callback.code, &code_verifier) {
        Ok(token) => Ok(BrowserCredential {
            token,
            callback: callback.stream,
        }),
        Err(error) => {
            let _ = callback_response(&mut callback.stream, false);
            Err(Error::Authentication {
                server: server_label(base_url),
                reason: error.to_string(),
            })
        }
    }
}

fn selected_login_target(matches: &ArgMatches) -> Result<(String, String, Option<String>), Error> {
    let config = config::load()?;
    let name = matches
        .get_one::<String>("profile-name")
        .cloned()
        .or(config.current_profile)
        .unwrap_or_else(|| "default".into());
    let override_url = matches
        .get_one::<String>("base-url")
        .map(|value| normalize_base_url(value))
        .transpose()?;
    let profile_url = config
        .profiles
        .get(&name)
        .map(|profile| normalize_base_url(&profile.base_url))
        .transpose()?;
    let base_url = override_url
        .or_else(|| profile_url.clone())
        .ok_or_else(|| {
            Error::Config(
                "no server URL; pass --base-url, set MARIMOHUB_URL, or configure a profile".into(),
            )
        })?;
    Ok((name, base_url, profile_url))
}

fn upgrade_hint(executable: &Path) -> &'static str {
    let path = executable.to_string_lossy();
    let parent = executable.parent();
    let updater = if cfg!(windows) {
        "mohub-update.exe"
    } else {
        "mohub-update"
    };
    if parent.is_some_and(|parent| parent.join(updater).is_file()) {
        "Run `mohub-update` to upgrade."
    } else if path.contains("/Cellar/") || path.contains("\\Homebrew\\") {
        "Run `brew upgrade mohub` to upgrade."
    } else if path.contains("node_modules") {
        "Run `npm update -g @marimo-team/mohub` to upgrade."
    } else {
        "Use your package manager to upgrade, or download the release from GitHub."
    }
}

fn check_for_update(matches: &ArgMatches) {
    if matches.get_flag("no-update-check") || !io::stderr().is_terminal() {
        return;
    }
    let informer = update_informer::new(
        registry::GitHub,
        "marimo-team/marimohub",
        env!("CARGO_PKG_VERSION"),
    )
    .timeout(Duration::from_secs(1));
    if let Ok(Some(version)) = informer.check_version() {
        let executable = std::env::current_exe().unwrap_or_default();
        eprintln!(
            "mohub {version} is available. {}",
            upgrade_hint(&executable)
        );
    }
}

fn handle_login(
    manifest: &manifest::Manifest,
    matches: &ArgMatches,
    leaf: &ArgMatches,
) -> Result<(), Error> {
    let (profile, base_url, expected_base_url) = selected_login_target(matches)?;
    if let Some(token) = supplied_token(leaf)? {
        let user = client::current_user(manifest, &auth_runtime(matches, &base_url, &token))
            .map_err(|error| Error::Authentication {
                server: server_label(&base_url),
                reason: error.to_string(),
            })?;
        config::set_profile(&profile, base_url.clone(), Some(&token))?;
        write_stdout(format_args!(
            "Logged in to {base_url} as {} (profile {profile}).\n",
            user_label(&user),
        ))?;
        return Ok(());
    }

    browser_login_origin(&base_url)?;
    let mut credential = browser_login(matches, &base_url, leaf.get_flag("no-browser"))?;
    if let Err(error) = config::complete_browser_login(
        &profile,
        &base_url,
        expected_base_url.as_deref(),
        &credential.token,
    ) {
        let _ = callback_response(&mut credential.callback, false);
        return Err(error);
    }
    let _ = callback_response(&mut credential.callback, true);
    write_stdout(format_args!(
        "Logged in to {base_url} (profile {profile}).\n"
    ))?;
    Ok(())
}

fn handle_status(manifest: &manifest::Manifest, matches: &ArgMatches) -> Result<(), Error> {
    let supplied = supplied_token(matches)?;
    let profile_name = matches
        .get_one::<String>("profile-name")
        .map(String::as_str);
    let selected = if supplied.is_some() {
        config::load_optional_profile_without_token(profile_name)?.ok_or_else(|| {
            Error::Config(
                "no profile selected; create one with `mohub profile set NAME --base-url URL`"
                    .into(),
            )
        })?
    } else {
        config::load_profile_with_token(profile_name)?
    };
    let profile = selected.name;
    let base_url = normalize_base_url(&selected.profile.base_url)?;
    require_matching_profile_server(matches, &profile, &base_url)?;
    let token = supplied.or(selected.token).ok_or_else(|| {
        Error::Config(format!(
            "not logged in for profile {profile:?}; run `mohub login`"
        ))
    })?;
    let user = client::current_user(manifest, &auth_runtime(matches, &base_url, &token))?;
    write_stdout(format_args!(
        "Authenticated to {base_url} as {} (profile {profile}).\n",
        user_label(&user),
    ))?;
    Ok(())
}

fn handle_logout(matches: &ArgMatches) -> Result<(), Error> {
    let (profile, base_url) = selected_profile(matches)?;
    config::delete_profile_token(&profile, &base_url)?;
    write_stdout(format_args!("Logged out of profile {profile}.\n"))?;
    Ok(())
}

fn resolve_runtime(matches: &ArgMatches) -> Result<(String, Option<SecretString>), Error> {
    let supplied_token = supplied_token(matches)?;
    let profile_name_argument = matches
        .get_one::<String>("profile-name")
        .map(String::as_str);
    let selected = if supplied_token.is_some() {
        config::load_optional_profile_without_token(profile_name_argument)?
    } else {
        config::load_optional_profile_with_token(profile_name_argument)?
    };
    let profile_name = selected.as_ref().map(|selected| selected.name.clone());
    let override_url = matches
        .get_one::<String>("base-url")
        .map(|value| normalize_base_url(value))
        .transpose()?;
    let profile_url = selected
        .as_ref()
        .map(|selected| normalize_base_url(&selected.profile.base_url))
        .transpose()?;
    let base_url = override_url
        .clone()
        .or_else(|| profile_url.clone())
        .ok_or_else(|| {
            Error::Config(
                "no server URL; pass --base-url, set MARIMOHUB_URL, or configure a profile".into(),
            )
        })?;
    let token = if let Some(token) = supplied_token {
        Some(token)
    } else if let Some(name) = profile_name.as_deref() {
        stored_token_for_server(
            name,
            override_url.as_deref(),
            profile_url.as_deref(),
            selected.and_then(|selected| selected.token),
        )?
    } else {
        None
    };
    Ok((base_url, token))
}

fn run() -> Result<(), Error> {
    let manifest = manifest::load();
    let mut command = cli::build(&manifest);
    let matches = command.clone().get_matches();
    let (path, leaf) = selected_command(&matches);
    let result = run_command(&manifest, &mut command, &matches, &path, leaf);
    if result.is_ok() && path.first().map(String::as_str) != Some("completions") {
        check_for_update(&matches);
    }
    result
}

fn run_command(
    manifest: &manifest::Manifest,
    command: &mut clap::Command,
    matches: &ArgMatches,
    path: &[String],
    leaf: &ArgMatches,
) -> Result<(), Error> {
    if path.first().map(String::as_str) == Some("profile") {
        return handle_profile(matches.subcommand().expect("selected profile").1);
    }
    if path.first().map(String::as_str) == Some("completions") {
        let shell = leaf.get_one::<String>("shell").expect("required by clap");
        if shell == "nushell" {
            clap_complete::generate(
                clap_complete_nushell::Nushell,
                command,
                "mohub",
                &mut io::stdout(),
            );
        } else {
            let shell = shell
                .parse::<clap_complete::Shell>()
                .map_err(Error::Usage)?;
            clap_complete::generate(shell, command, "mohub", &mut io::stdout());
        }
        return Ok(());
    }
    if path.first().map(String::as_str) == Some("login") {
        return handle_login(manifest, matches, leaf);
    }
    if path.first().map(String::as_str) == Some("status") {
        return handle_status(manifest, matches);
    }
    if path.first().map(String::as_str) == Some("logout") {
        return handle_logout(matches);
    }
    if path == ["notebooks", "deploy"] {
        if matches.get_flag("raw-envelope") {
            return Err(Error::Usage(
                "--raw-envelope cannot be combined with notebooks deploy".into(),
            ));
        }
        let prepared = deploy::prepare(deploy::DeployOptions {
            config: leaf
                .get_one::<String>("deploy-config")
                .map(std::path::PathBuf::from),
            notebooks: leaf
                .get_many::<String>("deploy-notebook")
                .map(|values| values.cloned().collect())
                .unwrap_or_default(),
            dry_run: leaf.get_flag("deploy-dry-run"),
            message: leaf.get_one::<String>("deploy-message").cloned(),
        })?;
        let (base_url, token) = resolve_runtime(matches)?;
        let runtime = client::Runtime {
            base_url: &base_url,
            token: token.as_ref(),
            timeout: Duration::from_secs(
                *matches
                    .get_one::<u64>("timeout")
                    .expect("defaulted by clap"),
            ),
            output: matches
                .get_one::<String>("output")
                .expect("defaulted by clap"),
            raw_envelope: matches.get_flag("raw-envelope"),
        };
        return deploy::execute(&runtime, prepared);
    }
    let operation = manifest
        .operations
        .iter()
        .find(|operation| operation.command == path)
        .ok_or_else(|| Error::Manifest(format!("no operation for command {}", path.join(" "))))?;
    let (base_url, token) = resolve_runtime(matches)?;
    let runtime = client::Runtime {
        base_url: &base_url,
        token: token.as_ref(),
        timeout: Duration::from_secs(
            *matches
                .get_one::<u64>("timeout")
                .expect("defaulted by clap"),
        ),
        output: matches
            .get_one::<String>("output")
            .expect("defaulted by clap"),
        raw_envelope: matches.get_flag("raw-envelope"),
    };
    client::execute(manifest, &runtime, operation, leaf)
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(Error::Cancelled) => ExitCode::from(130),
        Err(error) => {
            eprintln!("{:?}", miette::Report::new(error));
            ExitCode::from(1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use secrecy::ExposeSecret;

    #[test]
    fn embedded_manifest_covers_the_api() {
        let manifest = manifest::load();
        assert_eq!(manifest.operations.len(), 79);
        assert_eq!(manifest.api_version, "1.0.0");
        assert_eq!(
            manifest
                .operations
                .iter()
                .filter(|operation| operation.paginated)
                .count(),
            16
        );
        assert_eq!(
            manifest
                .operations
                .iter()
                .filter(|operation| {
                    operation.accepts_if_match && operation.preflight_operation_id.is_none()
                })
                .map(|operation| operation.id.as_str())
                .collect::<Vec<_>>(),
            [
                "alerts.destinations.delete",
                "alerts.destinations.test",
                "alerts.destinations.update",
            ]
        );
    }

    #[test]
    fn server_labels_never_include_credentials_or_paths() {
        assert_eq!(
            server_label("https://user:secret@example.com:8443/api?token=value"),
            "https://example.com:8443"
        );
    }

    #[test]
    fn base_urls_reject_embedded_credentials() {
        assert!(matches!(
            normalize_base_url("https://user:secret@example.com/api"),
            Err(Error::Usage(_))
        ));
    }

    #[test]
    fn base_urls_allow_plaintext_only_for_loopback_hosts() {
        for url in [
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://127.42.0.1:3000",
            "http://[::1]:3000",
        ] {
            assert!(normalize_base_url(url).is_ok(), "{url}");
        }
        assert!(matches!(
            normalize_base_url("http://hub.example.com"),
            Err(Error::Usage(message)) if message.contains("must use HTTPS")
        ));
    }

    #[test]
    fn server_overrides_must_match_profile_urls() {
        assert!(matching_server(
            Some("https://hub.example.com/"),
            Some("https://hub.example.com"),
        )
        .unwrap());
        assert!(!matching_server(
            Some("https://other.example.com"),
            Some("https://hub.example.com"),
        )
        .unwrap());
    }

    #[test]
    fn stored_tokens_are_only_rejected_for_other_servers() {
        let token = SecretString::from("mhub_pat_test".to_owned());
        assert!(matches!(
            stored_token_for_server(
                "default",
                Some("https://other.example.com"),
                Some("https://hub.example.com"),
                Some(token),
            ),
            Err(Error::Usage(_))
        ));
        assert!(stored_token_for_server(
            "default",
            Some("https://other.example.com"),
            Some("https://hub.example.com"),
            None,
        )
        .unwrap()
        .is_none());
        assert!(stored_token_for_server(
            "default",
            Some("https://hub.example.com/"),
            Some("https://hub.example.com"),
            Some(SecretString::from("mhub_pat_test".to_owned())),
        )
        .unwrap()
        .is_some());
    }

    #[test]
    fn profile_set_consumes_the_global_token_flag() {
        let matches = cli::build(&manifest::load())
            .try_get_matches_from([
                "mohub",
                "profile",
                "set",
                "work",
                "--base-url",
                "https://hub.example.com",
                "--token",
                "mhub_pat_test",
            ])
            .expect("valid profile command");
        let (_, leaf) = selected_command(&matches);

        assert_eq!(
            supplied_token(leaf)
                .unwrap()
                .as_ref()
                .map(ExposeSecret::expose_secret),
            Some("mhub_pat_test")
        );
    }

    #[test]
    fn login_accepts_token_stdin() {
        let matches = cli::build(&manifest::load())
            .try_get_matches_from(["mohub", "login", "--token-stdin"])
            .expect("valid login command");
        let (path, leaf) = selected_command(&matches);

        assert_eq!(path, ["login"]);
        assert!(leaf.get_flag("token-stdin"));
    }

    #[test]
    fn login_supports_a_headless_browser_flow() {
        let matches = cli::build(&manifest::load())
            .try_get_matches_from([
                "mohub",
                "--base-url",
                "https://hub.example.com",
                "login",
                "--no-browser",
            ])
            .expect("valid login command");
        let (path, leaf) = selected_command(&matches);

        assert_eq!(path, ["login"]);
        assert!(leaf.get_flag("no-browser"));
    }

    #[test]
    fn browser_login_url_rejects_a_hub_base_path() {
        let result = cli_login_url(
            "https://example.com/hub",
            "http://127.0.0.1:49152/callback",
            &"s".repeat(32),
            &"c".repeat(43),
        );

        assert!(matches!(result, Err(Error::Usage(message)) if message.contains("without a path")));
    }

    #[test]
    fn loopback_callback_requires_the_expected_state() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind callback");
        let address = listener.local_addr().expect("callback address");
        let state = "s".repeat(32);
        let client_state = state.clone();
        let browser = thread::spawn(move || {
            let mut stream = TcpStream::connect(address).expect("connect callback");
            write!(
                stream,
                "GET /callback?code=mhub_cli_code&state={client_state} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n"
            )
            .expect("write callback");
            let mut response = String::new();
            stream.read_to_string(&mut response).expect("read response");
            assert!(response.starts_with("HTTP/1.1 200 OK"));
        });

        let mut callback = wait_for_authorization(&listener, &state).expect("valid callback");
        assert_eq!(callback.code, "mhub_cli_code");
        callback_response(&mut callback.stream, true).expect("write completion page");
        drop(callback);
        browser.join().expect("browser completed");
    }

    #[test]
    fn login_rejects_multiple_token_sources() {
        let result = cli::build(&manifest::load()).try_get_matches_from([
            "mohub",
            "login",
            "--token-stdin",
            "--token",
            "mhub_pat_test",
        ]);

        assert!(result.is_err());
    }

    #[test]
    fn update_hint_recognizes_homebrew_and_falls_back_for_uv() {
        assert_eq!(
            upgrade_hint(Path::new(
                "/home/me/.local/share/uv/tools/marimohub-cli/bin/mohub"
            )),
            "Use your package manager to upgrade, or download the release from GitHub."
        );
        assert_eq!(
            upgrade_hint(Path::new("/opt/homebrew/Cellar/mohub/0.3.1/bin/mohub")),
            "Run `brew upgrade mohub` to upgrade."
        );
    }
}
