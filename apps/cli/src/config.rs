use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read};
use std::path::PathBuf;

use directories::ProjectDirs;
use keyring::Entry;
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};

use crate::Error;

const KEYRING_SERVICE: &str = "dev.marimo.marimohub.mohub";

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

pub fn path() -> Result<PathBuf, Error> {
    let dirs = ProjectDirs::from("dev", "marimo", "mohub")
        .ok_or_else(|| Error::Config("could not locate the user configuration directory".into()))?;
    Ok(dirs.config_dir().join("config.json"))
}

pub fn load() -> Result<Config, Error> {
    let path = path()?;
    match fs::read(&path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Config::default()),
        Err(error) => Err(error.into()),
    }
}

pub fn save(config: &Config) -> Result<(), Error> {
    let path = path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, serde_json::to_vec_pretty(config)?)?;
    fs::rename(temporary, path)?;
    Ok(())
}

fn keyring(profile: &str) -> Result<Entry, Error> {
    Entry::new(KEYRING_SERVICE, profile).map_err(|error| Error::Credential(error.to_string()))
}

pub fn get_token(profile: &str) -> Result<Option<SecretString>, Error> {
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
    keyring(profile)?
        .set_password(token.expose_secret())
        .map_err(|error| Error::Credential(error.to_string()))
}

pub fn delete_token(profile: &str) -> Result<(), Error> {
    match keyring(profile)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(Error::Credential(error.to_string())),
    }
}

#[cfg(test)]
mod tests {
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
}
