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

#[derive(Debug)]
pub struct ProfileWithToken {
    pub name: String,
    pub profile: Profile,
    pub token: Option<SecretString>,
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

pub fn normalize_base_url(value: &str) -> Result<String, Error> {
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

pub fn load() -> Result<Config, Error> {
    let path = path()?;
    let _lock = lock_for(&path)?;
    load_from(&path)
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
    set_profile_at(
        &path,
        name,
        base_url,
        token,
        set_credential,
        delete_credential,
    )
}

fn set_profile_at(
    path: &Path,
    name: &str,
    base_url: String,
    token: Option<&SecretString>,
    mut store_credential: impl FnMut(&str, &SecretString) -> Result<(), Error>,
    mut remove_credential: impl FnMut(&str) -> Result<(), Error>,
) -> Result<(), Error> {
    let _lock = lock_for(path)?;
    let mut config = load_from(path)?;
    let base_url = normalize_base_url(&base_url)?;
    let old_base_url = config
        .profiles
        .get(name)
        .map(|profile| normalize_base_url(&profile.base_url))
        .transpose()?;
    let account = credential_account(name, &base_url);
    let old_account = old_base_url
        .as_deref()
        .map(|old_base_url| credential_account(name, old_base_url));
    let url_changed = old_base_url.as_deref() != Some(base_url.as_str());

    if let Some(token) = token {
        store_credential(&account, token)?;
    } else if url_changed {
        remove_credential(&account)?;
    }

    config
        .profiles
        .insert(name.to_owned(), Profile { base_url });
    if config.current_profile.is_none() {
        config.current_profile = Some(name.to_owned());
    }
    save_to(path, &config)?;

    if let Some(old_account) = old_account {
        if old_account != account {
            remove_credential(&old_account)?;
        }
    }
    Ok(())
}

pub fn remove_profile(name: &str) -> Result<(), Error> {
    let path = path()?;
    remove_profile_from(&path, name, delete_credential)
}

fn remove_profile_from(
    path: &Path,
    name: &str,
    mut remove_credential: impl FnMut(&str) -> Result<(), Error>,
) -> Result<(), Error> {
    let _lock = lock_for(path)?;
    let mut config = load_from(path)?;
    let original = config.clone();
    let profile = config
        .profiles
        .get(name)
        .cloned()
        .ok_or_else(|| Error::Config(format!("profile {name:?} does not exist")))?;
    let base_url = normalize_base_url(&profile.base_url)?;
    if config.profiles.remove(name).is_none() {
        return Err(Error::Config(format!("profile {name:?} does not exist")));
    }
    if config.current_profile.as_deref() == Some(name) {
        config.current_profile = None;
    }
    save_to(path, &config)?;
    if let Err(error) = remove_credential(&credential_account(name, &base_url)) {
        return match save_to(path, &original) {
            Ok(()) => Err(error),
            Err(rollback) => Err(Error::Config(format!(
                "credential removal failed ({error}); restoring the profile also failed: {rollback}"
            ))),
        };
    }
    Ok(())
}

fn credential_account(profile: &str, base_url: &str) -> String {
    format!("v1:{}:{profile}{base_url}", profile.len())
}

fn keyring(account: &str) -> Result<Entry, Error> {
    Entry::new(KEYRING_SERVICE, account).map_err(|error| Error::Credential(error.to_string()))
}

fn get_credential(account: &str) -> Result<Option<SecretString>, Error> {
    #[cfg(target_os = "linux")]
    let _operation_lock = credential_operation_lock()?;
    #[cfg(target_os = "linux")]
    {
        let file = get_file_credential(account)?;
        resolve_file_credential(file, || match keyring(account)?.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(
                error @ (keyring::Error::PlatformFailure(_) | keyring::Error::NoStorageAccess(_)),
            ) => {
                warn_file_credentials(&error);
                Ok(None)
            }
            Err(error) => Err(Error::Credential(error.to_string())),
        })
    }

    #[cfg(not(target_os = "linux"))]
    match keyring(account)?.get_password() {
        Ok(token) => Ok(Some(SecretString::from(token))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(Error::Credential(error.to_string())),
    }
}

fn get_profile_credential(profile: &str, base_url: &str) -> Result<Option<SecretString>, Error> {
    get_profile_credential_with(profile, base_url, get_credential)
}

fn get_profile_credential_with(
    profile: &str,
    base_url: &str,
    get: impl FnOnce(&str) -> Result<Option<SecretString>, Error>,
) -> Result<Option<SecretString>, Error> {
    get(&credential_account(profile, &normalize_base_url(base_url)?))
}

pub fn load_profile_with_token(name: Option<&str>) -> Result<ProfileWithToken, Error> {
    let path = path()?;
    load_optional_profile_with_token_at(&path, name, get_profile_credential)?.ok_or_else(|| {
        Error::Config(
            "no profile selected; create one with `mohub profile set NAME --base-url URL`".into(),
        )
    })
}

pub fn load_optional_profile_with_token(
    name: Option<&str>,
) -> Result<Option<ProfileWithToken>, Error> {
    let path = path()?;
    load_optional_profile_with_token_at(&path, name, get_profile_credential)
}

pub fn load_optional_profile_without_token(
    name: Option<&str>,
) -> Result<Option<ProfileWithToken>, Error> {
    let path = path()?;
    load_optional_profile_with_token_at(&path, name, |_, _| Ok(None))
}

fn load_optional_profile_with_token_at(
    path: &Path,
    name: Option<&str>,
    get_token: impl FnOnce(&str, &str) -> Result<Option<SecretString>, Error>,
) -> Result<Option<ProfileWithToken>, Error> {
    let _lock = lock_for(path)?;
    let config = load_from(path)?;
    let Some(name) = name.map(str::to_owned).or(config.current_profile) else {
        return Ok(None);
    };
    let profile = config
        .profiles
        .get(&name)
        .cloned()
        .ok_or_else(|| Error::Config(format!("profile {name:?} does not exist")))?;
    let token = get_token(&name, &profile.base_url)?;
    Ok(Some(ProfileWithToken {
        name,
        profile,
        token,
    }))
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

fn set_credential(account: &str, token: &SecretString) -> Result<(), Error> {
    #[cfg(target_os = "linux")]
    {
        set_token_linux(account, token)
    }

    #[cfg(not(target_os = "linux"))]
    match keyring(account)?.set_password(token.expose_secret()) {
        Ok(()) => Ok(()),
        Err(error) => Err(Error::Credential(error.to_string())),
    }
}

fn delete_credential(account: &str) -> Result<(), Error> {
    #[cfg(target_os = "linux")]
    {
        delete_token_linux(account)
    }

    #[cfg(not(target_os = "linux"))]
    match keyring(account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(Error::Credential(error.to_string())),
    }
}

pub fn complete_browser_login(
    profile: &str,
    base_url: &str,
    expected_base_url: Option<&str>,
    token: &SecretString,
) -> Result<(), Error> {
    let path = path()?;
    complete_browser_login_at(
        &path,
        profile,
        base_url,
        expected_base_url,
        token,
        set_credential,
        delete_credential,
    )
}

fn complete_browser_login_at(
    path: &Path,
    profile: &str,
    base_url: &str,
    expected_base_url: Option<&str>,
    token: &SecretString,
    mut store_credential: impl FnMut(&str, &SecretString) -> Result<(), Error>,
    mut remove_credential: impl FnMut(&str) -> Result<(), Error>,
) -> Result<(), Error> {
    let _lock = lock_for(path)?;
    let mut config = load_from(path)?;
    let configured_base_url = config
        .profiles
        .get(profile)
        .map(|profile| normalize_base_url(&profile.base_url))
        .transpose()?;
    let expected_base_url = expected_base_url.map(normalize_base_url).transpose()?;
    if configured_base_url != expected_base_url {
        return Err(Error::Config(format!(
            "profile {profile:?} changed while authentication was in progress"
        )));
    }

    let base_url = normalize_base_url(base_url)?;
    let account = credential_account(profile, &base_url);
    store_credential(&account, token)?;
    config.profiles.insert(
        profile.to_owned(),
        Profile {
            base_url: base_url.clone(),
        },
    );
    if config.current_profile.is_none() {
        config.current_profile = Some(profile.to_owned());
    }
    save_to(path, &config)?;

    if let Some(previous_base_url) = configured_base_url {
        let previous_account = credential_account(profile, &previous_base_url);
        if previous_account != account {
            remove_credential(&previous_account)?;
        }
    }
    Ok(())
}

pub fn delete_profile_token(profile: &str, base_url: &str) -> Result<(), Error> {
    let path = path()?;
    delete_profile_token_at(&path, profile, base_url, delete_credential)
}

fn delete_profile_token_at(
    path: &Path,
    profile: &str,
    base_url: &str,
    mut remove_credential: impl FnMut(&str) -> Result<(), Error>,
) -> Result<(), Error> {
    let _lock = lock_for(path)?;
    let config = load_from(path)?;
    let configured = config
        .profiles
        .get(profile)
        .ok_or_else(|| Error::Config(format!("profile {profile:?} does not exist")))?;
    let configured_base_url = normalize_base_url(&configured.base_url)?;
    let base_url = normalize_base_url(base_url)?;
    if configured_base_url != base_url {
        return Err(Error::Config(format!(
            "profile {profile:?} changed while logout was in progress"
        )));
    }
    remove_credential(&credential_account(profile, &base_url))
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
            |_, _| Err(Error::Credential("keyring unavailable".into())),
            |_| Ok(()),
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
    fn failed_credential_cleanup_restores_the_profile() {
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
        let delete_calls = Cell::new(0);
        let result = remove_profile_from(&path, "default", |_| {
            delete_calls.set(delete_calls.get() + 1);
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
        assert_eq!(delete_calls.get(), 1);
    }

    #[test]
    fn changing_a_profile_url_without_a_token_clears_credentials() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.json");
        update_at(&path, |config| {
            config.profiles.insert(
                "default".into(),
                Profile {
                    base_url: "https://old.example.com".into(),
                },
            );
            Ok(())
        })
        .unwrap();
        let credentials = RefCell::new(BTreeMap::from([(
            credential_account("default", "https://old.example.com"),
            "old-token".to_owned(),
        )]));

        set_profile_at(
            &path,
            "default",
            "https://new.example.com".into(),
            None,
            |account, token| {
                credentials
                    .borrow_mut()
                    .insert(account.to_owned(), token.expose_secret().to_owned());
                Ok(())
            },
            |account| {
                credentials.borrow_mut().remove(account);
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(
            load_from(&path).unwrap().profiles["default"].base_url,
            "https://new.example.com"
        );
        assert!(credentials.borrow().is_empty());
    }

    #[test]
    fn setting_the_same_profile_url_without_a_token_preserves_credentials() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.json");
        let base_url = "https://hub.example.com";
        update_at(&path, |config| {
            config.profiles.insert(
                "default".into(),
                Profile {
                    base_url: format!("{base_url}/"),
                },
            );
            Ok(())
        })
        .unwrap();
        let account = credential_account("default", base_url);
        let credentials = RefCell::new(BTreeMap::from([(
            account.clone(),
            "current-token".to_owned(),
        )]));

        set_profile_at(
            &path,
            "default",
            base_url.into(),
            None,
            |account, token| {
                credentials
                    .borrow_mut()
                    .insert(account.to_owned(), token.expose_secret().to_owned());
                Ok(())
            },
            |account| {
                credentials.borrow_mut().remove(account);
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(
            credentials.borrow().get(&account).map(String::as_str),
            Some("current-token")
        );
        assert_eq!(
            load_from(&path).unwrap().profiles["default"].base_url,
            base_url
        );
    }

    #[test]
    fn profile_update_stages_the_new_token_before_publishing_the_url() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.json");
        update_at(&path, |config| {
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
        let old_account = credential_account("default", "https://old.example.com");
        let new_account = credential_account("default", "https://new.example.com");

        set_profile_at(
            &path,
            "default",
            "https://new.example.com".into(),
            Some(&token),
            |account, _| {
                assert_eq!(account, new_account);
                assert_eq!(
                    load_from(&path).unwrap().profiles["default"].base_url,
                    "https://old.example.com"
                );
                Ok(())
            },
            |account| {
                if account == old_account {
                    assert_eq!(
                        load_from(&path).unwrap().profiles["default"].base_url,
                        "https://new.example.com"
                    );
                }
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(
            load_from(&path).unwrap().profiles["default"].base_url,
            "https://new.example.com"
        );
    }

    #[test]
    fn browser_login_creates_the_profile_only_when_completed() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.json");
        let token = SecretString::from("new-token".to_owned());
        let stored_account = RefCell::new(None);

        complete_browser_login_at(
            &path,
            "default",
            "https://hub.example.com",
            None,
            &token,
            |account, _| {
                stored_account.replace(Some(account.to_owned()));
                Ok(())
            },
            |_| Ok(()),
        )
        .unwrap();

        let config = load_from(&path).unwrap();
        assert_eq!(config.current_profile.as_deref(), Some("default"));
        assert_eq!(
            config.profiles["default"].base_url,
            "https://hub.example.com"
        );
        assert_eq!(
            stored_account.into_inner(),
            Some(credential_account("default", "https://hub.example.com"))
        );
    }

    #[test]
    fn browser_login_rejects_a_profile_changed_during_authentication() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.json");
        update_at(&path, |config| {
            config.profiles.insert(
                "default".into(),
                Profile {
                    base_url: "https://changed.example.com".into(),
                },
            );
            Ok(())
        })
        .unwrap();
        let token = SecretString::from("new-token".to_owned());
        let credential_changed = Cell::new(false);

        let result = complete_browser_login_at(
            &path,
            "default",
            "https://new.example.com",
            Some("https://old.example.com"),
            &token,
            |_, _| {
                credential_changed.set(true);
                Ok(())
            },
            |_| {
                credential_changed.set(true);
                Ok(())
            },
        );

        assert!(matches!(result, Err(Error::Config(_))));
        assert!(!credential_changed.get());
        assert_eq!(
            load_from(&path).unwrap().profiles["default"].base_url,
            "https://changed.example.com"
        );
    }

    #[test]
    fn browser_login_replaces_the_previous_profile_after_authentication() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.json");
        update_at(&path, |config| {
            config.profiles.insert(
                "default".into(),
                Profile {
                    base_url: "https://old.example.com/".into(),
                },
            );
            Ok(())
        })
        .unwrap();
        let old_account = credential_account("default", "https://old.example.com");
        let new_account = credential_account("default", "https://new.example.com");
        let credentials = RefCell::new(BTreeMap::from([(
            old_account.clone(),
            "old-token".to_owned(),
        )]));
        let token = SecretString::from("new-token".to_owned());

        complete_browser_login_at(
            &path,
            "default",
            "https://new.example.com",
            Some("https://old.example.com"),
            &token,
            |account, token| {
                credentials
                    .borrow_mut()
                    .insert(account.to_owned(), token.expose_secret().to_owned());
                Ok(())
            },
            |account| {
                credentials.borrow_mut().remove(account);
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(
            load_from(&path).unwrap().profiles["default"].base_url,
            "https://new.example.com"
        );
        assert_eq!(
            credentials.borrow().get(&new_account).map(String::as_str),
            Some("new-token")
        );
        assert!(!credentials.borrow().contains_key(&old_account));
    }

    #[test]
    fn logout_accepts_a_canonical_match_for_a_stored_trailing_slash() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.json");
        update_at(&path, |config| {
            config.profiles.insert(
                "default".into(),
                Profile {
                    base_url: "https://hub.example.com/".into(),
                },
            );
            Ok(())
        })
        .unwrap();
        let removed_account = RefCell::new(None);

        delete_profile_token_at(&path, "default", "https://hub.example.com", |account| {
            removed_account.replace(Some(account.to_owned()));
            Ok(())
        })
        .unwrap();

        assert_eq!(
            removed_account.into_inner(),
            Some(credential_account("default", "https://hub.example.com"))
        );
    }

    #[test]
    fn profile_names_cannot_alias_scoped_credential_accounts() {
        let victim_account = credential_account("a", "https://victim.example.com");
        let expected_account = credential_account(&victim_account, "https://attacker.example.com");
        let requested_account = RefCell::new(None);

        let token = get_profile_credential_with(
            &victim_account,
            "https://attacker.example.com/",
            |account| {
                requested_account.replace(Some(account.to_owned()));
                Ok((account == victim_account)
                    .then(|| SecretString::from("victim-token".to_owned())))
            },
        )
        .unwrap();

        assert!(token.is_none());
        assert_ne!(expected_account, victim_account);
        assert_eq!(requested_account.into_inner(), Some(expected_account));
    }
}
