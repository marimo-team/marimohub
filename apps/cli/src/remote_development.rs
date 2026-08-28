use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc::{self, TryRecvError};
use std::thread;
use std::time::Duration;

use clap::ArgMatches;
use directories::{ProjectDirs, UserDirs};
use fs2::FileExt;
use secrecy::{ExposeSecret, SecretString};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;
use tungstenite::client::IntoClientRequest;
use tungstenite::http::HeaderValue;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{connect, Error as WebSocketError, Message};
use url::Url;

use crate::Error;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub project_id: String,
    pub notebook_id: String,
    pub session_id: String,
}

impl Target {
    pub fn from_matches(matches: &ArgMatches) -> Result<Self, Error> {
        let value = |name: &str| {
            matches.get_one::<String>(name).cloned().ok_or_else(|| {
                Error::Usage(format!("missing --{}", name.trim_start_matches("remote-")))
            })
        };
        Ok(Self {
            project_id: value("remote-pid")?,
            notebook_id: value("remote-nid")?,
            session_id: value("remote-sid")?,
        })
    }
}

#[derive(Debug, Deserialize)]
struct PreparedAccess {
    username: String,
    workspace_path: String,
    host_key: String,
}

#[derive(Debug, Deserialize)]
struct Envelope<T> {
    success: bool,
    data: Option<T>,
    error: Option<ApiError>,
}

#[derive(Debug, Deserialize)]
struct ApiError {
    code: String,
    message: String,
}

struct LocalAccess {
    alias: String,
    key: PathBuf,
    public_key: String,
    ssh_config: PathBuf,
    known_hosts: PathBuf,
}

fn profile_hash(profile: &str) -> String {
    format!("{:x}", Sha256::digest(profile.as_bytes()))[..12].to_owned()
}

fn target_hash(session_id: &str) -> String {
    format!("{:x}", Sha256::digest(session_id.as_bytes()))[..16].to_owned()
}

fn host_alias(profile: &str, session_id: &str) -> String {
    format!(
        "mohub-{}-{}",
        profile_hash(profile),
        target_hash(session_id)
    )
}

fn local_access(profile: &str, session_id: &str) -> Result<LocalAccess, Error> {
    let dirs = ProjectDirs::from("dev", "marimo", "mohub")
        .ok_or_else(|| Error::Config("could not locate the user configuration directory".into()))?;
    let root = dirs
        .data_local_dir()
        .join("remote-development")
        .join(profile_hash(profile));
    fs::create_dir_all(&root)?;
    set_directory_permissions(&root)?;
    let key = root.join("id_ed25519");
    ensure_key(&key, profile)?;
    let public_key = fs::read_to_string(key.with_extension("pub"))?
        .trim()
        .to_owned();
    let target = target_hash(session_id);
    Ok(LocalAccess {
        alias: host_alias(profile, session_id),
        key,
        public_key,
        ssh_config: root.join(format!("ssh_config_{target}")),
        known_hosts: root.join(format!("known_hosts_{target}")),
    })
}

#[cfg(unix)]
fn set_directory_permissions(path: &Path) -> Result<(), Error> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_directory_permissions(_path: &Path) -> Result<(), Error> {
    Ok(())
}

#[cfg(unix)]
fn set_file_permissions(path: &Path) -> Result<(), Error> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_file_permissions(_path: &Path) -> Result<(), Error> {
    Ok(())
}

fn write_private_file(path: &Path, content: &[u8]) -> Result<(), Error> {
    let parent = path
        .parent()
        .ok_or_else(|| Error::Config("remote-development path has no parent".into()))?;
    fs::create_dir_all(parent)?;
    let mut temporary = NamedTempFile::new_in(parent)?;
    temporary.write_all(content)?;
    temporary.as_file().sync_all()?;
    set_file_permissions(temporary.path())?;
    temporary
        .persist(path)
        .map_err(|error| Error::Io(error.error))?;
    Ok(())
}

fn ensure_key(path: &Path, profile: &str) -> Result<(), Error> {
    if path.is_file() && path.with_extension("pub").is_file() {
        return Ok(());
    }
    let status = Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-C"])
        .arg(format!("mohub:{profile}"))
        .arg("-f")
        .arg(path)
        .status()
        .map_err(|error| missing_program("ssh-keygen", error))?;
    if !status.success() {
        return Err(Error::Config(
            "ssh-keygen could not create the remote-development key".into(),
        ));
    }
    Ok(())
}

fn prepare(
    base_url: &str,
    token: &SecretString,
    target: &Target,
    public_key: &str,
) -> Result<PreparedAccess, Error> {
    let url = format!(
        "{}/api/v1/projects/{}/notebooks/{}/sessions/{}/remote-development/ssh/prepare",
        base_url.trim_end_matches('/'),
        urlencoding::encode(&target.project_id),
        urlencoding::encode(&target.notebook_id),
        urlencoding::encode(&target.session_id),
    );
    let result = ureq::post(&url)
        .set(
            "Authorization",
            &format!("Bearer {}", token.expose_secret()),
        )
        .set("Content-Type", "application/json")
        .send_json(serde_json::json!({ "public_key": public_key }));
    let response = match result {
        Ok(response) => response,
        Err(ureq::Error::Status(_, response)) => response,
        Err(error) => return Err(error.into()),
    };
    let status = response.status();
    let envelope: Envelope<PreparedAccess> = response.into_json()?;
    if !(200..300).contains(&status) || !envelope.success {
        let error = envelope
            .error
            .map(|error| format!("{}: {}", error.code, error.message));
        return Err(Error::Http(
            error.unwrap_or_else(|| format!("HTTP {status}")),
        ));
    }
    envelope
        .data
        .ok_or_else(|| Error::Http("prepare response has no data".into()))
}

fn quote_config(value: &str) -> Result<String, Error> {
    if value.contains(['\r', '\n']) {
        return Err(Error::Config(
            "SSH configuration values must not contain newlines".into(),
        ));
    }
    Ok(format!(
        "\"{}\"",
        value.replace('\\', "\\\\").replace('"', "\\\"")
    ))
}

fn install_config(
    profile: &str,
    target: &Target,
    local: &LocalAccess,
    prepared: &PreparedAccess,
) -> Result<(), Error> {
    write_private_file(
        &local.known_hosts,
        format!("{} {}\n", local.alias, prepared.host_key.trim()).as_bytes(),
    )?;
    let executable = std::env::current_exe()?;
    let proxy = [
        quote_config(&executable.to_string_lossy())?,
        "--profile".into(),
        quote_config(profile)?,
        "proxy-ssh".into(),
        "--pid".into(),
        quote_config(&target.project_id)?,
        "--nid".into(),
        quote_config(&target.notebook_id)?,
        "--sid".into(),
        quote_config(&target.session_id)?,
    ]
    .join(" ");
    let config = format!(
        "Host {alias}\n  HostName marimohub.invalid\n  User {user}\n  IdentityFile {key}\n  IdentitiesOnly yes\n  HostKeyAlias {alias}\n  UserKnownHostsFile {known_hosts}\n  StrictHostKeyChecking yes\n  ProxyCommand {proxy}\n",
        alias = local.alias,
        user = prepared.username,
        key = quote_config(&local.key.to_string_lossy())?,
        known_hosts = quote_config(&local.known_hosts.to_string_lossy())?,
    );
    write_private_file(&local.ssh_config, config.as_bytes())?;
    install_user_include(&local.ssh_config)?;
    Ok(())
}

fn install_user_include(managed_config: &Path) -> Result<(), Error> {
    let user = UserDirs::new()
        .ok_or_else(|| Error::Config("could not locate the user home directory".into()))?;
    let ssh_dir = user.home_dir().join(".ssh");
    install_user_include_at(&ssh_dir, managed_config)
}

fn install_user_include_at(ssh_dir: &Path, managed_config: &Path) -> Result<(), Error> {
    fs::create_dir_all(ssh_dir)?;
    set_directory_permissions(ssh_dir)?;
    let config_path = ssh_dir.join("config");
    let lock = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(ssh_dir.join(".mohub-config.lock"))?;
    set_file_permissions(&ssh_dir.join(".mohub-config.lock"))?;
    lock.lock_exclusive()?;
    let write_path = match fs::symlink_metadata(&config_path) {
        Ok(metadata) if metadata.file_type().is_symlink() => fs::canonicalize(&config_path)?,
        Ok(_) => config_path,
        Err(error) if error.kind() == io::ErrorKind::NotFound => config_path,
        Err(error) => return Err(error.into()),
    };
    let include = format!(
        "Include {}",
        quote_config(&managed_config.to_string_lossy())?
    );
    let existing = match fs::read_to_string(&write_path) {
        Ok(existing) => existing,
        Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error.into()),
    };
    if existing.lines().any(|line| line.trim() == include) {
        return Ok(());
    }
    let terminator = if existing.is_empty() || existing.ends_with('\n') {
        ""
    } else {
        "\n"
    };
    write_private_file(
        &write_path,
        format!("{include}\n{existing}{terminator}").as_bytes(),
    )?;
    FileExt::unlock(&lock)?;
    Ok(())
}

fn prepare_local(
    profile: &str,
    base_url: &str,
    token: &SecretString,
    target: &Target,
) -> Result<(LocalAccess, PreparedAccess), Error> {
    let local = local_access(profile, &target.session_id)?;
    let prepared = prepare(base_url, token, target, &local.public_key)?;
    install_config(profile, target, &local, &prepared)?;
    Ok((local, prepared))
}

pub fn open_ssh(
    profile: &str,
    base_url: &str,
    token: &SecretString,
    target: &Target,
) -> Result<(), Error> {
    let (local, _) = prepare_local(profile, base_url, token, target)?;
    let status = Command::new("ssh")
        .args(["-F"])
        .arg(&local.ssh_config)
        .arg(&local.alias)
        .status()
        .map_err(|error| missing_program("ssh", error))?;
    if status.success() {
        Ok(())
    } else {
        Err(Error::Transport(format!("ssh exited with {status}")))
    }
}

pub fn open_code(
    profile: &str,
    base_url: &str,
    token: &SecretString,
    target: &Target,
) -> Result<(), Error> {
    let (local, prepared) = prepare_local(profile, base_url, token, target)?;
    let status = Command::new("code")
        .args(["--remote", &format!("ssh-remote+{}", local.alias)])
        .arg(&prepared.workspace_path)
        .status()
        .map_err(|error| missing_program("code", error))?;
    if status.success() {
        Ok(())
    } else {
        Err(Error::Transport(format!("code exited with {status}")))
    }
}

fn missing_program(program: &str, error: io::Error) -> Error {
    if error.kind() == io::ErrorKind::NotFound {
        Error::Config(format!(
            "required program `{program}` was not found in PATH"
        ))
    } else {
        Error::Io(error)
    }
}

pub fn proxy(
    profile: &str,
    base_url: &str,
    token: &SecretString,
    target: &Target,
) -> Result<(), Error> {
    let local = local_access(profile, &target.session_id)?;
    let _ = prepare(base_url, token, target, &local.public_key)?;
    let mut url = Url::parse(&format!(
        "{}/api/v1/projects/{}/notebooks/{}/sessions/{}/remote-development/ssh/relay",
        base_url.trim_end_matches('/'),
        urlencoding::encode(&target.project_id),
        urlencoding::encode(&target.notebook_id),
        urlencoding::encode(&target.session_id),
    ))?;
    url.set_scheme(if url.scheme() == "https" { "wss" } else { "ws" })
        .map_err(|_| Error::Config("unsupported Hub URL scheme".into()))?;
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|error| Error::Transport(error.to_string()))?;
    request.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {}", token.expose_secret()))
            .map_err(|error| Error::Transport(error.to_string()))?,
    );
    let (mut websocket, _) =
        connect(request).map_err(|error| Error::Transport(error.to_string()))?;
    match websocket.get_mut() {
        MaybeTlsStream::Plain(stream) => {
            stream.set_read_timeout(Some(Duration::from_millis(50)))?
        }
        MaybeTlsStream::Rustls(stream) => stream
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(50)))?,
        _ => {}
    }
    let (sender, receiver) = mpsc::sync_channel::<Vec<u8>>(8);
    thread::spawn(move || {
        let mut stdin = io::stdin().lock();
        loop {
            let mut bytes = vec![0_u8; 32 * 1024];
            match stdin.read(&mut bytes) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    bytes.truncate(read);
                    if sender.send(bytes).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let mut stdout = io::stdout().lock();
    loop {
        loop {
            match receiver.try_recv() {
                Ok(bytes) => websocket
                    .send(Message::Binary(bytes.into()))
                    .map_err(|error| Error::Transport(error.to_string()))?,
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    let _ = websocket.close(None);
                    return Ok(());
                }
            }
        }
        match websocket.read() {
            Ok(Message::Binary(bytes)) => {
                stdout.write_all(&bytes)?;
                stdout.flush()?;
            }
            Ok(Message::Close(_)) => return Ok(()),
            Ok(_) => {}
            Err(WebSocketError::Io(error))
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) => {}
            Err(WebSocketError::ConnectionClosed | WebSocketError::AlreadyClosed) => return Ok(()),
            Err(error) => return Err(Error::Transport(error.to_string())),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::sync::{Arc, Barrier};

    use super::*;

    #[test]
    fn config_values_escape_spaces_quotes_and_backslashes() {
        assert_eq!(
            quote_config(r#"C:\\My Files\\\"mohub\""#).unwrap(),
            "\"C:\\\\\\\\My Files\\\\\\\\\\\\\\\"mohub\\\\\\\"\""
        );
        assert!(quote_config("bad\nvalue").is_err());
        assert!(quote_config("bad\rvalue").is_err());
    }

    #[test]
    fn aliases_are_profile_isolated() {
        assert_ne!(
            host_alias("work", "session"),
            host_alias("personal", "session")
        );
    }

    #[test]
    fn private_files_replace_content_and_restrict_unix_permissions() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory
            .path()
            .join("directory with spaces")
            .join("known_hosts");
        write_private_file(&path, b"old").unwrap();
        write_private_file(&path, b"new").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn invalid_user_ssh_config_is_not_overwritten() {
        let directory = tempfile::tempdir().unwrap();
        let ssh_dir = directory.path().join(".ssh");
        fs::create_dir_all(&ssh_dir).unwrap();
        let config = ssh_dir.join("config");
        fs::write(&config, [0xff, 0xfe]).unwrap();

        let error = install_user_include_at(&ssh_dir, Path::new("/managed/config")).unwrap_err();

        assert!(matches!(error, Error::Io(error) if error.kind() == io::ErrorKind::InvalidData));
        assert_eq!(fs::read(config).unwrap(), [0xff, 0xfe]);
    }

    #[test]
    fn user_ssh_config_read_errors_are_not_treated_as_an_empty_file() {
        let directory = tempfile::tempdir().unwrap();
        let ssh_dir = directory.path().join(".ssh");
        fs::create_dir_all(ssh_dir.join("config")).unwrap();

        assert!(install_user_include_at(&ssh_dir, Path::new("/managed/config")).is_err());
        assert!(ssh_dir.join("config").is_dir());
    }

    #[test]
    fn concurrent_user_ssh_config_updates_keep_every_include() {
        let directory = tempfile::tempdir().unwrap();
        let ssh_dir = Arc::new(directory.path().join(".ssh"));
        let barrier = Arc::new(Barrier::new(16));
        let threads = (0..16)
            .map(|index| {
                let ssh_dir = Arc::clone(&ssh_dir);
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    install_user_include_at(&ssh_dir, Path::new(&format!("/managed/{index}")))
                        .unwrap();
                })
            })
            .collect::<Vec<_>>();

        for thread in threads {
            thread.join().unwrap();
        }

        let config = fs::read_to_string(ssh_dir.join("config")).unwrap();
        let includes = config
            .lines()
            .filter(|line| line.starts_with("Include "))
            .collect::<HashSet<_>>();
        assert_eq!(includes.len(), 16);
        assert_eq!(config.lines().count(), 16);
        for index in 0..16 {
            assert!(includes.contains(format!(r#"Include "/managed/{index}""#).as_str()));
        }
    }

    #[cfg(unix)]
    #[test]
    fn user_ssh_config_symlink_and_target_are_preserved() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let ssh_dir = directory.path().join(".ssh");
        let dotfiles = directory.path().join("dotfiles");
        fs::create_dir_all(&ssh_dir).unwrap();
        fs::create_dir_all(&dotfiles).unwrap();
        let target = dotfiles.join("ssh-config");
        fs::write(&target, "Host existing\n").unwrap();
        let config = ssh_dir.join("config");
        symlink(&target, &config).unwrap();

        install_user_include_at(&ssh_dir, Path::new("/managed/config")).unwrap();

        assert!(fs::symlink_metadata(&config)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_link(&config).unwrap(), target);
        assert_eq!(
            fs::read_to_string(&config).unwrap(),
            "Include \"/managed/config\"\nHost existing\n"
        );
    }
}
