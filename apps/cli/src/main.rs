use std::fs;
use std::io::{self, IsTerminal, Write};
use std::path::Path;
use std::process::ExitCode;
use std::time::Duration;

use clap::ArgMatches;
use inquire::Password;
use mohub::{cli, client, config, manifest, Error};
use secrecy::SecretString;
use update_informer::{registry, Check};

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
    let url = url::Url::parse(value)?;
    if !matches!(url.scheme(), "http" | "https") || url.host().is_none() {
        return Err(Error::Usage(
            "server URL must be an absolute HTTP or HTTPS URL".into(),
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(Error::Usage(
            "server URL must not contain a username or password".into(),
        ));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(Error::Usage(
            "server URL must not contain a query string or fragment".into(),
        ));
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
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
    if !matching_server(
        matches.get_one::<String>("base-url").map(String::as_str),
        Some(&profile_url),
    )? {
        return Err(Error::Usage(format!(
			"server override does not match profile {name:?}; update the profile or select a matching one"
		)));
    }
    Ok((name, profile_url))
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
    let (profile, base_url) = selected_profile(matches)?;
    let token = match supplied_token(leaf)? {
        Some(token) => token,
        None if io::stdin().is_terminal() => SecretString::from(
            Password::new("Token:")
                .without_confirmation()
                .prompt()
                .map_err(|error| Error::Prompt(error.to_string()))?,
        ),
        None => {
            return Err(Error::Usage(
                "no token supplied; pipe one to `mohub login --token-stdin` or use --token-file"
                    .into(),
            ));
        }
    };
    let user = client::current_user(manifest, &auth_runtime(matches, &base_url, &token)).map_err(
        |error| Error::Authentication {
            server: server_label(&base_url),
            reason: error.to_string(),
        },
    )?;
    config::set_token(&profile, &token)?;
    write_stdout(format_args!(
        "Logged in to {base_url} as {} (profile {profile}).\n",
        user_label(&user),
    ))?;
    Ok(())
}

fn handle_status(manifest: &manifest::Manifest, matches: &ArgMatches) -> Result<(), Error> {
    let (profile, base_url) = selected_profile(matches)?;
    let supplied = supplied_token(matches)?;
    let token = match supplied {
        Some(token) => token,
        None => config::get_token(&profile)?.ok_or_else(|| {
            Error::Config(format!(
                "not logged in for profile {profile:?}; run `mohub login --token-stdin`"
            ))
        })?,
    };
    let user = client::current_user(manifest, &auth_runtime(matches, &base_url, &token))?;
    write_stdout(format_args!(
        "Authenticated to {base_url} as {} (profile {profile}).\n",
        user_label(&user),
    ))?;
    Ok(())
}

fn handle_logout(matches: &ArgMatches) -> Result<(), Error> {
    let (profile, _) = selected_profile(matches)?;
    config::delete_token(&profile)?;
    write_stdout(format_args!("Logged out of profile {profile}.\n"))?;
    Ok(())
}

fn resolve_runtime(matches: &ArgMatches) -> Result<(String, Option<SecretString>), Error> {
    let config = config::load()?;
    let profile_name = matches
        .get_one::<String>("profile-name")
        .cloned()
        .or(config.current_profile.clone());
    let profile = profile_name
        .as_ref()
        .and_then(|name| config.profiles.get(name));
    if let Some(name) = &profile_name {
        if profile.is_none() {
            return Err(Error::Config(format!("profile {name:?} does not exist")));
        }
    }
    let supplied_token = supplied_token(matches)?;
    let override_url = matches
        .get_one::<String>("base-url")
        .map(|value| normalize_base_url(value))
        .transpose()?;
    let profile_url = profile
        .map(|profile| normalize_base_url(&profile.base_url))
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
            config::get_token(name)?,
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
        assert_eq!(manifest.operations.len(), 86);
        assert_eq!(manifest.api_version, "1.0.0");
        assert_eq!(
            manifest
                .operations
                .iter()
                .filter(|operation| operation.paginated)
                .count(),
            17
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
