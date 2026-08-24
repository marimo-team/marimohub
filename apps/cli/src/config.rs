use std::collections::BTreeMap;
#[cfg(any(target_os = "linux", test))]
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
#[cfg(target_os = "linux")]
use std::sync::Once;

use directories::ProjectDirs;
use fs2::FileExt;
use keyring::Entry;
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use tempfile::NamedTempFile;

use crate::Error;

const KEYRING_SERVICE: &str = "dev.marimo.marimohub.mohub";
#[cfg(target_os = "linux")]
static FILE_CREDENTIAL_WARNING: Once = Once::new();

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Config {
    #[serde(default)]
    pub current_profile: Option<String>,
    #[serde(default)]
    pub profiles: BTreeMap<String, Profile>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Profile {
    pub base_url: String,
}

#[cfg(any(target_os = "linux", test))]
#[derive(Default, Deserialize, Serialize)]
struct FileCredentials {
    #[serde(default)]
    tokens: BTreeMap<String, String>,
    // File state stays authoritative so a stale keyring entry cannot resurface.
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    deleted: BTreeSet<String>,
}

#[cfg(any(target_os = "linux", test))]
#[derive(Clone, Debug, PartialEq, Eq)]
enum FileCredential {
    Missing,
    Token(String),
    Deleted,
}

#[cfg(any(target_os = "linux", test))]
impl FileCredentials {
    fn get(&self, profile: &str) -> FileCredential {
        if let Some(token) = self.tokens.get(profile) {
            FileCredential::Token(token.clone())
        } else if self.deleted.contains(profile) {
            FileCredential::Deleted
        } else {
            FileCredential::Missing
        }
    }

    fn set(&mut self, profile: &str, credential: FileCredential) {
        self.tokens.remove(profile);
        self.deleted.remove(profile);
        match credential {
            FileCredential::Missing => {}
            FileCredential::Token(token) => {
                self.tokens.insert(profile.to_owned(), token);
            }
            FileCredential::Deleted => {
                self.deleted.insert(profile.to_owned());
            }
        }
    }
}

#[cfg(any(target_os = "linux", test))]
fn resolve_file_credential(
    file: FileCredential,
    keyring_token: impl FnOnce() -> Result<Option<String>, Error>,
) -> Result<Option<SecretString>, Error> {
    match file {
        FileCredential::Token(token) => Ok(Some(SecretString::from(token))),
        FileCredential::Deleted => Ok(None),
        FileCredential::Missing => Ok(keyring_token()?.map(SecretString::from)),
    }
}

#[cfg(any(target_os = "linux", test))]
fn set_linux_credential(
    current: FileCredential,
    token: &str,
    set_keyring: impl FnOnce(&str) -> keyring::Result<()>,
    set_file: impl FnOnce(FileCredential) -> Result<(), Error>,
    warn: impl FnOnce(&keyring::Error),
) -> Result<(), Error> {
    if current != FileCredential::Missing {
        return set_file(FileCredential::Token(token.to_owned()));
    }

    match set_keyring(token) {
        Ok(()) => Ok(()),
        Err(error @ (keyring::Error::PlatformFailure(_) | keyring::Error::NoStorageAccess(_))) => {
            warn(&error);
            set_file(FileCredential::Token(token.to_owned()))
        }
        Err(error) => Err(Error::Credential(error.to_string())),
    }
}

#[cfg(any(target_os = "linux", test))]
fn delete_linux_credential(
    current: FileCredential,
    delete_keyring: impl FnOnce() -> keyring::Result<()>,
    set_file: impl FnOnce(FileCredential) -> Result<(), Error>,
    warn: impl FnOnce(&keyring::Error),
) -> Result<(), Error> {
    let has_file_state = current != FileCredential::Missing;

    match delete_keyring() {
        Ok(()) | Err(keyring::Error::NoEntry) => {
            if has_file_state {
                set_file(FileCredential::Missing)
            } else {
                Ok(())
            }
        }
        Err(error @ (keyring::Error::PlatformFailure(_) | keyring::Error::NoStorageAccess(_))) => {
            warn(&error);
            if current == FileCredential::Deleted {
                Ok(())
            } else {
                set_file(FileCredential::Deleted)
            }
        }
        Err(error) => Err(Error::Credential(error.to_string())),
    }
}

pub fn path() -> Result<PathBuf, Error> {
    let dirs = ProjectDirs::from("dev", "marimo", "mohub")
        .ok_or_else(|| Error::Config("could not locate the user configuration directory".into()))?;
    Ok(dirs.config_dir().join("config.json"))
}

pub fn load() -> Result<Config, Error> {
    load_from(&path()?)
}

fn load_from(path: &Path) -> Result<Config, Error> {
    match fs::read(path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Config::default()),
        Err(error) => Err(error.into()),
    }
}

fn lock_for(path: &Path) -> Result<File, Error> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let lock_path = path.with_extension("lock");
    let lock = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(lock_path)?;
    lock.lock_exclusive()?;
    Ok(lock)
}

fn atomic_write(path: &Path, bytes: &[u8], secret: bool) -> Result<(), Error> {
    let parent = path
        .parent()
        .ok_or_else(|| Error::Config("configuration path has no parent directory".into()))?;
    fs::create_dir_all(parent)?;
    let mut temporary = NamedTempFile::new_in(parent)?;
    #[cfg(unix)]
    if secret {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    let _ = secret;
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(path)
        .map_err(|error| Error::Io(error.error))?;
    #[cfg(unix)]
    File::open(parent)?.sync_all()?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn remove_file_if_exists(path: &Path) -> Result<(), Error> {
    match fs::remove_file(path) {
        Ok(()) => {
            #[cfg(unix)]
            if let Some(parent) = path.parent() {
                File::open(parent)?.sync_all()?;
            }
            Ok(())
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn save_to(path: &Path, config: &Config) -> Result<(), Error> {
    atomic_write(path, &serde_json::to_vec_pretty(config)?, false)
}

pub fn update<T>(change: impl FnOnce(&mut Config) -> Result<T, Error>) -> Result<T, Error> {
    let path = path()?;
    update_at(&path, change)
}

fn update_at<T>(
    path: &Path,
    change: impl FnOnce(&mut Config) -> Result<T, Error>,
) -> Result<T, Error> {
    let _lock = lock_for(path)?;
    let mut config = load_from(path)?;
    let result = change(&mut config)?;
    save_to(path, &config)?;
    Ok(result)
}

pub fn set_profile(
    name: &str,
    base_url: String,
    token: Option<&SecretString>,
) -> Result<(), Error> {
    let path = path()?;
    set_profile_at(&path, name, base_url, token, |token| set_token(name, token))
}

fn set_profile_at(
    path: &Path,
    name: &str,
    base_url: String,
    token: Option<&SecretString>,
    store_credential: impl FnOnce(&SecretString) -> Result<(), Error>,
) -> Result<(), Error> {
    let _lock = lock_for(path)?;
    let mut config = load_from(path)?;
    let original = config.clone();
    config
        .profiles
        .insert(name.to_owned(), Profile { base_url });
    if config.current_profile.is_none() {
        config.current_profile = Some(name.to_owned());
    }
    save_to(path, &config)?;

    if let Some(token) = token {
        if let Err(error) = store_credential(token) {
            return match save_to(path, &original) {
                Ok(()) => Err(error),
                Err(rollback) => Err(Error::Config(format!(
                    "credential storage failed ({error}); restoring the profile also failed: {rollback}"
                ))),
            };
        }
    }
    Ok(())
}

pub fn remove_profile(name: &str) -> Result<(), Error> {
    let path = path()?;
    remove_profile_from(&path, name, || delete_token(name))
}

fn remove_profile_from(
    path: &Path,
    name: &str,
    remove_credential: impl FnOnce() -> Result<(), Error>,
) -> Result<(), Error> {
    let _lock = lock_for(path)?;
    let mut config = load_from(path)?;
    let original = config.clone();
    if config.profiles.remove(name).is_none() {
        return Err(Error::Config(format!("profile {name:?} does not exist")));
    }
    if config.current_profile.as_deref() == Some(name) {
        config.current_profile = None;
    }
    save_to(path, &config)?;
    if let Err(error) = remove_credential() {
        return match save_to(path, &original) {
            Ok(()) => Err(error),
            Err(rollback) => Err(Error::Config(format!(
				"credential removal failed ({error}); restoring the profile also failed: {rollback}"
			))),
        };
    }
    Ok(())
}

fn keyring(profile: &str) -> Result<Entry, Error> {
    Entry::new(KEYRING_SERVICE, profile).map_err(|error| Error::Credential(error.to_string()))
}

pub fn get_token(profile: &str) -> Result<Option<SecretString>, Error> {
    #[cfg(target_os = "linux")]
    let _operation_lock = credential_operation_lock()?;
    #[cfg(target_os = "linux")]
    {
        let file = get_file_credential(profile)?;
        return resolve_file_credential(file, || match keyring(profile)?.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(
                error @ (keyring::Error::PlatformFailure(_) | keyring::Error::NoStorageAccess(_)),
            ) => {
                warn_file_credentials(&error);
                Ok(None)
            }
            Err(error) => Err(Error::Credential(error.to_string())),
        });
    }

    #[cfg(not(target_os = "linux"))]
    match keyring(profile)?.get_password() {
        Ok(token) => Ok(Some(SecretString::from(token))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(Error::Credential(error.to_string())),
    }
}

pub fn read_token(mut reader: impl Read) -> Result<SecretString, Error> {
    let mut token = String::new();
    reader.read_to_string(&mut token)?;
    let token = token.trim();
    if token.is_empty() {
        return Err(Error::Config(
            "credential input did not contain a token".into(),
        ));
    }
    Ok(SecretString::from(token.to_owned()))
}

pub fn set_token(profile: &str, token: &SecretString) -> Result<(), Error> {
    #[cfg(target_os = "linux")]
    {
        return set_token_linux(profile, token);
    }

    #[cfg(not(target_os = "linux"))]
    match keyring(profile)?.set_password(token.expose_secret()) {
        Ok(()) => Ok(()),
        Err(error) => Err(Error::Credential(error.to_string())),
    }
}

pub fn delete_token(profile: &str) -> Result<(), Error> {
    #[cfg(target_os = "linux")]
    {
        return delete_token_linux(profile);
    }

    #[cfg(not(target_os = "linux"))]
    match keyring(profile)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(Error::Credential(error.to_string())),
    }
}

#[cfg(target_os = "linux")]
fn set_token_linux(profile: &str, token: &SecretString) -> Result<(), Error> {
    let _operation_lock = credential_operation_lock()?;
    let current = get_file_credential(profile)?;
    set_linux_credential(
        current,
        token.expose_secret(),
        |token| Entry::new(KEYRING_SERVICE, profile)?.set_password(token),
        |credential| set_file_credential(profile, credential),
        warn_file_credentials,
    )
}

#[cfg(target_os = "linux")]
fn delete_token_linux(profile: &str) -> Result<(), Error> {
    let _operation_lock = credential_operation_lock()?;
    let current = get_file_credential(profile)?;
    delete_linux_credential(
        current,
        || Entry::new(KEYRING_SERVICE, profile)?.delete_credential(),
        |credential| set_file_credential(profile, credential),
        warn_file_credentials,
    )
}

#[cfg(target_os = "linux")]
fn credentials_path() -> Result<PathBuf, Error> {
    Ok(path()?.with_file_name("credentials.json"))
}

#[cfg(target_os = "linux")]
fn credential_operation_lock() -> Result<File, Error> {
    let path = credentials_path()?.with_file_name("credentials-operation.json");
    lock_for(&path)
}

#[cfg(target_os = "linux")]
fn read_file_credentials(path: &Path) -> Result<FileCredentials, Error> {
    match fs::read(path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(FileCredentials::default()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(target_os = "linux")]
fn update_file_credentials(
    change: impl FnOnce(&mut FileCredentials),
) -> Result<FileCredentials, Error> {
    let path = credentials_path()?;
    let _lock = lock_for(&path)?;
    let mut credentials = read_file_credentials(&path)?;
    change(&mut credentials);
    if credentials.tokens.is_empty() && credentials.deleted.is_empty() {
        remove_file_if_exists(&path)?;
    } else {
        atomic_write(&path, &serde_json::to_vec_pretty(&credentials)?, true)?;
    }
    Ok(credentials)
}

#[cfg(target_os = "linux")]
fn get_file_credential(profile: &str) -> Result<FileCredential, Error> {
    let path = credentials_path()?;
    let _lock = lock_for(&path)?;
    let credentials = read_file_credentials(&path)?;
    Ok(credentials.get(profile))
}

#[cfg(target_os = "linux")]
fn set_file_credential(profile: &str, credential: FileCredential) -> Result<(), Error> {
    update_file_credentials(|credentials| {
        credentials.set(profile, credential);
    })?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn warn_file_credentials(error: &keyring::Error) {
    FILE_CREDENTIAL_WARNING.call_once(|| {
        eprintln!(
            "Warning: the system credential store is unavailable ({error}). Tokens are stored in a user-only credentials file."
        );
    });
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};
    use std::sync::Arc;
    use std::thread;

    use super::*;

    #[test]
    fn token_input_is_trimmed() {
        assert_eq!(
            read_token("  mhub_pat_example\n".as_bytes())
                .unwrap()
                .expose_secret(),
            "mhub_pat_example"
        );
    }

    #[test]
    fn empty_token_input_is_rejected() {
        assert!(matches!(
            read_token(" \n".as_bytes()),
            Err(Error::Config(_))
        ));
    }

    #[test]
    fn file_token_overrides_a_stale_keyring_value() {
        let resolved =
            resolve_file_credential(FileCredential::Token("current-file-token".into()), || {
                Ok(Some("stale-keyring-token".into()))
            })
            .unwrap()
            .unwrap();

        assert_eq!(resolved.expose_secret(), "current-file-token");
    }

    #[test]
    fn deletion_marker_hides_a_stale_keyring_value() {
        let mut credentials = FileCredentials::default();
        credentials.set("default", FileCredential::Deleted);

        assert_eq!(credentials.get("default"), FileCredential::Deleted);
        let restored: FileCredentials =
            serde_json::from_str(&serde_json::to_string(&credentials).unwrap()).unwrap();
        assert_eq!(restored.get("default"), FileCredential::Deleted);

        let resolved = resolve_file_credential(restored.get("default"), || {
            Ok(Some("stale-keyring-token".into()))
        })
        .unwrap();
        assert!(resolved.is_none());
    }

    #[test]
    fn replacing_a_file_credential_clears_the_previous_state() {
        let mut credentials = FileCredentials::default();
        credentials.set("default", FileCredential::Deleted);
        credentials.set("default", FileCredential::Token("replacement".into()));
        assert!(!credentials.deleted.contains("default"));

        credentials.set("default", FileCredential::Missing);
        assert_eq!(credentials.get("default"), FileCredential::Missing);
    }

    #[test]
    fn failed_keyring_write_does_not_stage_the_new_token() {
        let file_write_called = Cell::new(false);
        let result = set_linux_credential(
            FileCredential::Missing,
            "new-token",
            |_| Err(keyring::Error::Invalid("profile".into(), "invalid".into())),
            |_| {
                file_write_called.set(true);
                Err(Error::Config("file write failed".into()))
            },
            |_| {},
        );

        assert!(matches!(result, Err(Error::Credential(_))));
        assert!(!file_write_called.get());
    }

    #[test]
    fn failed_keyring_delete_does_not_stage_a_deletion() {
        let file_write_called = Cell::new(false);
        let result = delete_linux_credential(
            FileCredential::Missing,
            || Err(keyring::Error::Invalid("profile".into(), "invalid".into())),
            |_| {
                file_write_called.set(true);
                Err(Error::Config("file write failed".into()))
            },
            |_| {},
        );

        assert!(matches!(result, Err(Error::Credential(_))));
        assert!(!file_write_called.get());
    }

    #[test]
    fn deletion_marker_retries_keyring_and_clears_when_empty() {
        for keyring_result in [Ok(()), Err(keyring::Error::NoEntry)] {
            let keyring_delete_called = Cell::new(false);
            let stored = RefCell::new(Vec::new());
            delete_linux_credential(
                FileCredential::Deleted,
                || {
                    keyring_delete_called.set(true);
                    keyring_result
                },
                |credential| {
                    stored.borrow_mut().push(credential);
                    Ok(())
                },
                |_| {},
            )
            .unwrap();

            assert!(keyring_delete_called.get());
            assert_eq!(stored.into_inner(), vec![FileCredential::Missing]);
        }
    }

    #[test]
    fn file_backed_profile_stays_file_backed() {
        let keyring_write_called = Cell::new(false);
        let stored = RefCell::new(None);
        set_linux_credential(
            FileCredential::Token("old-token".into()),
            "new-token",
            |_| {
                keyring_write_called.set(true);
                Ok(())
            },
            |credential| {
                stored.replace(Some(credential));
                Ok(())
            },
            |_| {},
        )
        .unwrap();

        assert!(!keyring_write_called.get());
        assert_eq!(
            stored.into_inner(),
            Some(FileCredential::Token("new-token".into()))
        );
    }

    #[test]
    fn concurrent_updates_do_not_lose_profiles() {
        let directory = tempfile::tempdir().unwrap();
        let path = Arc::new(directory.path().join("config.json"));
        let threads = (0..16)
            .map(|index| {
                let path = Arc::clone(&path);
                thread::spawn(move || {
                    update_at(&path, |config| {
                        config.profiles.insert(
                            format!("profile-{index}"),
                            Profile {
                                base_url: format!("https://{index}.example.com"),
                            },
                        );
                        Ok(())
                    })
                    .unwrap();
                })
            })
            .collect::<Vec<_>>();

        for thread in threads {
            thread.join().unwrap();
        }

        assert_eq!(load_from(&path).unwrap().profiles.len(), 16);
    }

    #[test]
    fn failed_credential_storage_restores_the_profile() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.json");
        update_at(&path, |config| {
            config.current_profile = Some("default".into());
            config.profiles.insert(
                "default".into(),
                Profile {
                    base_url: "https://old.example.com".into(),
                },
            );
            Ok(())
        })
        .unwrap();
        let token = SecretString::from("new-token".to_owned());

        let result = set_profile_at(
            &path,
            "default",
            "https://new.example.com".into(),
            Some(&token),
            |_| Err(Error::Credential("keyring unavailable".into())),
        );

        assert!(matches!(result, Err(Error::Credential(_))));
        let config = load_from(&path).unwrap();
        assert_eq!(config.current_profile.as_deref(), Some("default"));
        assert_eq!(
            config.profiles["default"].base_url,
            "https://old.example.com"
        );
    }

    #[test]
    fn failed_credential_removal_restores_the_profile() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.json");
        update_at(&path, |config| {
            config.current_profile = Some("default".into());
            config.profiles.insert(
                "default".into(),
                Profile {
                    base_url: "https://hub.example.com".into(),
                },
            );
            Ok(())
        })
        .unwrap();

        let credential = RefCell::new(FileCredential::Token("current-token".into()));
        let result = remove_profile_from(&path, "default", || {
            let current = credential.borrow().clone();
            delete_linux_credential(
                current,
                || Err(keyring::Error::Invalid("profile".into(), "invalid".into())),
                |next| {
                    credential.replace(next);
                    Ok(())
                },
                |_| {},
            )
        });

        assert!(matches!(result, Err(Error::Credential(_))));
        let config = load_from(&path).unwrap();
        assert_eq!(config.current_profile.as_deref(), Some("default"));
        assert!(config.profiles.contains_key("default"));
        assert_eq!(
            credential.into_inner(),
            FileCredential::Token("current-token".into())
        );
    }
}
