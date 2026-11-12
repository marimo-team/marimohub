use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use clap::{Arg, ArgAction, ArgMatches};
use serde_json::json;

use crate::{client, config, Error};

pub fn command() -> clap::Command {
    let mut command =
        clap::Command::new("push").about("Push a workspace archive using MARIMOHUB_SYNC_TOKEN");
    for name in ["pid", "nid", "root-path", "repo", "branch", "commit"] {
        let mut arg = Arg::new(name).long(name);
        if matches!(name, "pid" | "nid") {
            arg = arg
                .required_unless_present("manifest")
                .conflicts_with("manifest");
        }
        command = command.arg(arg);
    }
    command
        .arg(Arg::new("manifest").long("manifest").help("JSON array of {path, pid, nid, secret}; secret names a sync-token environment variable").conflicts_with_all(["root-path", "include-git"]))
        .arg(
            Arg::new("format")
                .long("format")
                .value_parser(["tar.gz", "zip"])
                .default_value("tar.gz"),
        )
        .arg(
            Arg::new("include-git")
                .long("include-git")
                .action(ArgAction::SetTrue),
        )
        .arg(
            Arg::new("dry-run")
                .long("dry-run")
                .action(ArgAction::SetTrue),
        )
}

fn git(directory: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .current_dir(directory)
        .args(args)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .filter(|s| !s.is_empty())
}

fn resolve(
    explicit: Option<String>,
    local: Option<String>,
    env: impl IntoIterator<Item = Option<String>>,
    name: &str,
) -> Result<String, Error> {
    explicit
        .into_iter()
        .chain(local)
        .chain(env.into_iter().flatten())
        .find(|value| !value.trim().is_empty())
        .ok_or_else(|| Error::Usage(format!("cannot resolve {name}; pass --{name}")))
}

fn repository(remote: String) -> String {
    if let Ok(mut url) = url::Url::parse(&remote) {
        // Remote URLs can contain credentials; never copy them into headers or dry-run output.
        let _ = url.set_username("");
        let _ = url.set_password(None);
        url.set_query(None);
        url.set_fragment(None);
        return url
            .to_string()
            .trim_end_matches('/')
            .trim_end_matches(".git")
            .to_owned();
    }
    if let Some((host, path)) = remote.split_once(':') {
        if host.contains('@') {
            return format!(
                "https://{}/{}",
                host.rsplit('@').next().unwrap(),
                path.trim_end_matches(".git")
            );
        }
    }
    remote.trim_end_matches(".git").to_owned()
}

fn files(root: &Path, include_git: bool) -> Result<Vec<PathBuf>, Error> {
    let mut builder = ignore::WalkBuilder::new(root);
    builder
        .standard_filters(false)
        .add_custom_ignore_filename(".marimohubignore");
    builder.filter_entry(move |entry| {
        include_git
            || !entry
                .file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case(".git")
    });
    let mut paths = Vec::new();
    let mut total = 0;
    for entry in builder.build() {
        let entry = entry.map_err(|error| Error::Usage(error.to_string()))?;
        let kind = entry
            .file_type()
            .ok_or_else(|| Error::Usage("unknown file type".into()))?;
        if kind.is_dir() {
            continue;
        }
        if !kind.is_file() {
            return Err(Error::Usage(format!(
                "cannot archive special file: {}",
                entry.path().display()
            )));
        }
        let size = entry
            .metadata()
            .map_err(|e| Error::Usage(e.to_string()))?
            .len();
        total += size;
        paths.push(
            entry
                .path()
                .strip_prefix(root)
                .expect("walk root")
                .to_owned(),
        );
        if size > 25 * 1024 * 1024 || total > 100 * 1024 * 1024 || paths.len() > 1000 {
            return Err(Error::Usage(
                "workspace exceeds limits: 1,000 files, 25 MiB per file, 100 MiB total".into(),
            ));
        }
    }
    paths.sort();
    if paths.is_empty() {
        return Err(Error::Usage("workspace contains no files".into()));
    }
    Ok(paths)
}

fn archive(root: &Path, paths: &[PathBuf], format: &str) -> Result<File, Error> {
    let mut file = tempfile::tempfile()?;
    if format == "zip" {
        let mut zip = zip::ZipWriter::new(&mut file);
        for path in paths {
            zip.start_file(
                path.to_string_lossy().replace('\\', "/"),
                zip::write::SimpleFileOptions::default(),
            )
            .map_err(|e| Error::Usage(e.to_string()))?;
            std::io::copy(&mut File::open(root.join(path))?, &mut zip)?;
        }
        zip.finish().map_err(|e| Error::Usage(e.to_string()))?;
    } else {
        let encoder = flate2::write::GzEncoder::new(&mut file, flate2::Compression::default());
        let mut tar = tar::Builder::new(encoder);
        for path in paths {
            tar.append_path_with_name(root.join(path), path)?;
        }
        tar.into_inner()?.finish()?;
    }
    file.flush()?;
    file.seek(SeekFrom::Start(0))?;
    Ok(file)
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct App {
    path: String,
    pid: String,
    nid: String,
    secret: String,
}

pub fn execute(global: &ArgMatches, args: &ArgMatches) -> Result<(), Error> {
    let output = global
        .get_one::<String>("output")
        .expect("defaulted by clap");
    let Some(manifest) = args.get_one::<String>("manifest") else {
        return client::write_output(&execute_one(global, args, "MARIMOHUB_SYNC_TOKEN")?, output);
    };
    let apps: Vec<App> = serde_json::from_reader(File::open(manifest)?)?;
    if apps.is_empty() || apps.len() > 256 {
        return Err(Error::Usage("manifest must contain 1 to 256 apps".into()));
    }
    let mut targets = std::collections::BTreeSet::new();
    let mut prepared = Vec::new();
    for app in apps {
        if app.pid.is_empty()
            || app.nid.is_empty()
            || !targets.insert((app.pid.clone(), app.nid.clone()))
        {
            return Err(Error::Usage(
                "manifest contains an empty or duplicate project/notebook target".into(),
            ));
        }
        if app.secret.is_empty()
            || !app
                .secret
                .bytes()
                .enumerate()
                .all(|(i, b)| b == b'_' || b.is_ascii_alphabetic() || (i > 0 && b.is_ascii_digit()))
        {
            return Err(Error::Usage(
                "manifest secret must name an environment variable".into(),
            ));
        }
        if !args.get_flag("dry-run")
            && std::env::var(&app.secret)
                .ok()
                .is_none_or(|s| s.trim().is_empty())
        {
            return Err(Error::Config(format!(
                "set {} for {}/{}",
                app.secret, app.pid, app.nid
            )));
        }
        let mut argv = vec![
            "push".to_owned(),
            "--pid".into(),
            app.pid.clone(),
            "--nid".into(),
            app.nid.clone(),
            "--root-path".into(),
            app.path.clone(),
        ];
        for name in ["repo", "branch", "commit", "format"] {
            if let Some(value) = args.get_one::<String>(name) {
                argv.extend([format!("--{name}"), value.clone()]);
            }
        }
        let mut dry_argv = argv.clone();
        dry_argv.push("--dry-run".into());
        let dry = command()
            .try_get_matches_from(dry_argv)
            .map_err(|e| Error::Usage(e.to_string()))?;
        let plan = execute_one(global, &dry, &app.secret)?;
        let single = command()
            .try_get_matches_from(argv)
            .map_err(|e| Error::Usage(e.to_string()))?;
        prepared.push((app, single, plan));
    }
    let mut failed = 0;
    let mut results = Vec::with_capacity(prepared.len());
    for (app, single, plan) in prepared {
        let result = if args.get_flag("dry-run") {
            Ok(plan)
        } else {
            execute_one(global, &single, &app.secret)
        };
        results.push(match result {
            Ok(data) => json!({"pid": app.pid, "nid": app.nid, "success": true, "data": data}),
            Err(error) => {
                failed += 1;
                json!({"pid": app.pid, "nid": app.nid, "success": false, "error": error.to_string()})
            }
        });
    }
    client::write_output(&json!({"notebooks": results}), output)?;
    if failed > 0 {
        return Err(Error::Deployment(format!(
            "{failed} notebook pushes failed; see per-notebook results"
        )));
    }
    Ok(())
}

fn execute_one(
    global: &ArgMatches,
    args: &ArgMatches,
    token_env: &str,
) -> Result<serde_json::Value, Error> {
    for name in ["token", "token-file"] {
        if global.value_source(name) == Some(clap::parser::ValueSource::CommandLine) {
            return Err(Error::Usage(
                "push only accepts MARIMOHUB_SYNC_TOKEN from the environment".into(),
            ));
        }
    }
    let cwd = std::env::current_dir()?;
    let checkout = git(&cwd, &["rev-parse", "--show-toplevel"])
        .map(PathBuf::from)
        .unwrap_or(cwd);
    let get = |name: &str| args.get_one::<String>(name).cloned();
    let root_path = get("root-path").unwrap_or_default().replace('\\', "/");
    if root_path.split('/').any(|part| part == ".." || part == ".")
        || Path::new(&root_path).is_absolute()
    {
        return Err(Error::Usage(
            "root-path must be relative to the repository root without . or .. segments".into(),
        ));
    }
    let root = checkout.join(&root_path).canonicalize()?;
    if !root.starts_with(checkout.canonicalize()?) {
        return Err(Error::Usage("root-path escapes the checkout".into()));
    }
    let include_git = args.get_flag("include-git");
    if include_git && (!root_path.is_empty() || !root.join(".git").is_dir()) {
        return Err(Error::Usage(
            "include-git requires the repository root and a .git directory (not a worktree link)"
                .into(),
        ));
    }
    if include_git
        && git(
            &root,
            &[
                "config",
                "--local",
                "--get-regexp",
                "http\\..*extraheader|credential\\..*",
            ],
        )
        .is_some()
    {
        return Err(Error::Usage(
            "remove checkout credentials before including .git; use persist-credentials: false"
                .into(),
        ));
    }
    if include_git {
        let remotes = git(
            &root,
            &["config", "--local", "--get-regexp", "remote\\..*\\.url"],
        )
        .unwrap_or_default();
        if remotes
            .lines()
            .filter_map(|line| line.split_once(' '))
            .any(|(_, value)| {
                url::Url::parse(value).is_ok_and(|url| {
                    url.password().is_some()
                        || (url.scheme() == "https" && !url.username().is_empty())
                })
            })
        {
            return Err(Error::Usage(
                "remove credentials from Git remote URLs before including .git".into(),
            ));
        }
    }
    let env = |names: [&str; 2]| names.map(|name| std::env::var(name).ok());
    let repo = repository(resolve(
        get("repo"),
        git(&checkout, &["remote", "get-url", "origin"]),
        env(["GITHUB_REPOSITORY", "CI_PROJECT_PATH"]),
        "repo",
    )?);
    let branch = resolve(
        get("branch"),
        git(&checkout, &["symbolic-ref", "--short", "HEAD"]),
        env(["GITHUB_REF_NAME", "CI_COMMIT_REF_NAME"]),
        "branch",
    )?;
    let commit = resolve(
        get("commit"),
        git(&checkout, &["rev-parse", "HEAD"]),
        env(["GITHUB_SHA", "CI_COMMIT_SHA"]),
        "commit",
    )?;
    if include_git
        && git(
            &root,
            &["rev-parse", "--verify", &format!("{commit}^{{commit}}")],
        )
        .is_none()
    {
        return Err(Error::Usage(
            "include-git requires the requested commit in the checkout".into(),
        ));
    }
    let format = get("format").expect("defaulted by clap");
    let paths = files(&root, include_git)?;
    let headers = [
        ("x-marimohub-repo", repo),
        ("x-marimohub-branch", branch),
        ("x-marimohub-commit", commit),
        ("x-marimohub-root-path", root_path),
        ("x-marimohub-archive-format", format.clone()),
    ];
    if args.get_flag("dry-run") {
        return Ok(
            json!({"pid": get("pid"), "nid": get("nid"), "headers": headers.into_iter().collect::<std::collections::BTreeMap<_, _>>(), "files": paths}),
        );
    }
    let base = match global.get_one::<String>("base-url") {
        Some(base) => base.clone(),
        None => config::load_optional_profile_without_token(
            global.get_one::<String>("profile-name").map(String::as_str),
        )?
        .map(|p| p.profile.base_url)
        .ok_or_else(|| Error::Config("set MARIMOHUB_URL or --base-url".into()))?,
    };
    let base = config::normalize_base_url(&base)?;
    let token = std::env::var(token_env)
        .ok()
        .map(|token| token.trim().to_owned())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| Error::Config(format!("set {token_env}")))?;
    let url = format!(
        "{}/api/sync/git/v1/projects/{}/notebooks/{}",
        base.trim_end_matches('/'),
        urlencoding::encode(&get("pid").unwrap()),
        urlencoding::encode(&get("nid").unwrap())
    );
    let body = archive(&root, &paths, &format)?;
    // Sync credentials must never follow a redirect to another origin.
    let agent = ureq::AgentBuilder::new()
        .redirects(0)
        .timeout(Duration::from_secs(
            *global.get_one::<u64>("timeout").unwrap(),
        ))
        .build();
    let mut request = agent
        .post(&url)
        .set("Authorization", &format!("Bearer {}", token.trim()))
        .set(
            "Content-Type",
            if format == "zip" {
                "application/zip"
            } else {
                "application/gzip"
            },
        )
        .set("Content-Length", &body.metadata()?.len().to_string());
    for (name, value) in &headers {
        request = request.set(name, value);
    }
    let response = match request.send(body) {
        Ok(response) | Err(ureq::Error::Status(_, response)) => response,
        Err(error) => {
            return Err(Error::Transport(
                error.to_string().replace(&token, "[REDACTED]"),
            ))
        }
    };
    let status = response.status();
    let mut text = String::new();
    response
        .into_reader()
        .take(1024 * 1024)
        .read_to_string(&mut text)?;
    let value: serde_json::Value = serde_json::from_str(&text.replace(&token, "[REDACTED]"))?;
    if !(200..300).contains(&status) || value["success"] != true {
        return Err(Error::Http(format!(
            "sync failed (HTTP {status}): {}",
            value["error"]["message"]
                .as_str()
                .unwrap_or("invalid sync response")
        )));
    }
    if global.get_flag("raw-envelope") {
        return Ok(value);
    }
    Ok(json!({"version_id": value["data"]["version_id"], "synced": value["data"]["synced"]}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_precedence_and_detached_ci_fallback() {
        assert_eq!(
            resolve(
                Some("explicit".into()),
                Some("git".into()),
                [Some("ci".into())],
                "branch"
            )
            .unwrap(),
            "explicit"
        );
        assert_eq!(
            resolve(None, Some("git".into()), [Some("ci".into())], "branch").unwrap(),
            "git"
        );
        assert_eq!(
            resolve(None, None, [Some("ci".into())], "branch").unwrap(),
            "ci"
        );
        assert!(resolve(None, None, [], "branch").is_err());
    }

    #[test]
    fn remote_credentials_are_removed() {
        assert_eq!(
            repository("https://user:secret@github.com/org/repo.git".into()),
            "https://github.com/org/repo"
        );
        assert_eq!(
            repository("git@github.com:org/repo.git".into()),
            "https://github.com/org/repo"
        );
    }

    #[test]
    fn ignores_and_archives() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        std::fs::write(dir.path().join(".git/config"), "git data").unwrap();
        std::fs::write(dir.path().join("app.py"), "print(1)").unwrap();
        std::fs::write(dir.path().join("secret"), "secret").unwrap();
        std::fs::write(dir.path().join(".marimohubignore"), "secret\n").unwrap();
        let paths = files(dir.path(), false).unwrap();
        assert_eq!(
            paths,
            [PathBuf::from(".marimohubignore"), PathBuf::from("app.py")]
        );
        let zip = archive(dir.path(), &paths, "zip").unwrap();
        let mut zip = zip::ZipArchive::new(zip).unwrap();
        assert_eq!(zip.len(), 2);
        assert_eq!(zip.by_name("app.py").unwrap().size(), 8);
        let tgz = archive(dir.path(), &paths, "tar.gz").unwrap();
        let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(tgz));
        assert_eq!(tar.entries().unwrap().count(), 2);
        assert!(files(dir.path(), true)
            .unwrap()
            .contains(&PathBuf::from(".git/config")));
    }
}
