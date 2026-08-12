use std::collections::BTreeMap;
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

#[cfg(target_os = "linux")]
#[derive(Default, Deserialize, Serialize)]
struct FileCredentials {
    tokens: BTreeMap<String, String>,
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
    match keyring(profile)?.get_password() {
        Ok(token) => Ok(Some(SecretString::from(token))),
        #[cfg(not(target_os = "linux"))]
        Err(keyring::Error::NoEntry) => Ok(None),
        #[cfg(target_os = "linux")]
        Err(keyring::Error::NoEntry) => get_file_token(profile),
        #[cfg(target_os = "linux")]
        Err(error @ (keyring::Error::PlatformFailure(_) | keyring::Error::NoStorageAccess(_))) => {
            warn_file_credentials(&error);
            get_file_token(profile)
        }
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
    match keyring(profile)?.set_password(token.expose_secret()) {
        Ok(()) => {
            #[cfg(target_os = "linux")]
            delete_file_token(profile)?;
            Ok(())
        }
        #[cfg(target_os = "linux")]
        Err(error @ (keyring::Error::PlatformFailure(_) | keyring::Error::NoStorageAccess(_))) => {
            warn_file_credentials(&error);
            set_file_token(profile, token)
        }
        Err(error) => Err(Error::Credential(error.to_string())),
    }
}

pub fn delete_token(profile: &str) -> Result<(), Error> {
    match keyring(profile)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {
            #[cfg(target_os = "linux")]
            delete_file_token(profile)?;
            Ok(())
        }
        #[cfg(target_os = "linux")]
        Err(error @ (keyring::Error::PlatformFailure(_) | keyring::Error::NoStorageAccess(_))) => {
            warn_file_credentials(&error);
            delete_file_token(profile)
        }
        Err(error) => Err(Error::Credential(error.to_string())),
    }
}

#[cfg(target_os = "linux")]
fn credentials_path() -> Result<PathBuf, Error> {
    Ok(path()?.with_file_name("credentials.json"))
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
    if credentials.tokens.is_empty() {
        remove_file_if_exists(&path)?;
    } else {
        atomic_write(&path, &serde_json::to_vec_pretty(&credentials)?, true)?;
    }
    Ok(credentials)
}

#[cfg(target_os = "linux")]
fn get_file_token(profile: &str) -> Result<Option<SecretString>, Error> {
    let path = credentials_path()?;
    let _lock = lock_for(&path)?;
    let credentials = read_file_credentials(&path)?;
    Ok(credentials
        .tokens
        .get(profile)
        .cloned()
        .map(SecretString::from))
}

#[cfg(target_os = "linux")]
fn set_file_token(profile: &str, token: &SecretString) -> Result<(), Error> {
    update_file_credentials(|credentials| {
        credentials
            .tokens
            .insert(profile.to_owned(), token.expose_secret().to_owned());
    })?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn delete_file_token(profile: &str) -> Result<(), Error> {
    update_file_credentials(|credentials| {
        credentials.tokens.remove(profile);
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

        let result = remove_profile_from(&path, "default", || {
            Err(Error::Credential("credential store unavailable".into()))
        });

        assert!(matches!(result, Err(Error::Credential(_))));
        let config = load_from(&path).unwrap();
        assert_eq!(config.current_profile.as_deref(), Some("default"));
        assert!(config.profiles.contains_key("default"));
    }
}
