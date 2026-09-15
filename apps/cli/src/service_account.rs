use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;

use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};
use time::{format_description::well_known::Rfc3339, Duration, OffsetDateTime};

use crate::Error;

const MAX_CONFIG_BYTES: usize = 65536;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Account {
    id: String,
    #[serde(
        default,
        deserialize_with = "optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    name: Option<String>,
    actions: Vec<String>,
    credentials: Vec<Credential>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Credential {
    id: String,
    sha256: String,
    #[serde(
        default,
        deserialize_with = "optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    expires_at: Option<String>,
}

fn optional_string<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

fn invalid(message: &str) -> Error {
    Error::Config(format!("Invalid service-account configuration: {message}"))
}

fn validate_id(id: &str) -> Result<(), Error> {
    if id.is_empty()
        || id.len() > 64
        || !id.as_bytes()[0].is_ascii_lowercase()
        || !id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(invalid(
            "IDs must use 1–64 lowercase letters, digits, or hyphens, starting with a letter",
        ));
    }
    Ok(())
}

fn valid_expiry(value: &str) -> bool {
    if !value.ends_with('Z')
        || value.as_bytes().get(10) != Some(&b'T')
        || value.get(17..19) == Some("60")
    {
        return false;
    }
    // The server also accepts UTC timestamps without seconds.
    let value = if value.len() == 17 {
        format!("{}:00Z", &value[..16])
    } else {
        value.to_owned()
    };
    OffsetDateTime::parse(&value, &Rfc3339).is_ok()
}

fn parse_accounts(raw: &[u8]) -> Result<Vec<Account>, Error> {
    if raw.len() > MAX_CONFIG_BYTES {
        return Err(invalid("configuration exceeds 64 KiB"));
    }
    // Serde errors can repeat unknown fields or accidentally pasted credentials.
    let accounts: Vec<Account> = serde_json::from_slice(raw).map_err(|_| {
        invalid("expected a JSON array with only documented account and credential fields")
    })?;
    if accounts.len() > 32 {
        return Err(invalid("at most 32 accounts are supported"));
    }
    let mut ids = HashSet::new();
    let mut hashes = HashSet::new();
    for account in &accounts {
        validate_id(&account.id)?;
        if !ids.insert(&account.id) {
            return Err(invalid("account IDs must be unique"));
        }
        if account
            .name
            .as_ref()
            .is_some_and(|name| name.trim().is_empty() || name.trim().encode_utf16().count() > 100)
        {
            return Err(invalid(
                "names must contain 1–100 characters after trimming",
            ));
        }
        if account.actions != ["org-integration.manage"] {
            return Err(invalid(
                "actions must contain org-integration.manage exactly once",
            ));
        }
        if account.credentials.is_empty() || account.credentials.len() > 4 {
            return Err(invalid("each account must have 1–4 credentials"));
        }
        let mut keys = HashSet::new();
        for credential in &account.credentials {
            validate_id(&credential.id)?;
            if !keys.insert(&credential.id) {
                return Err(invalid("credential IDs must be unique within an account"));
            }
            if credential.sha256.len() != 64
                || !credential
                    .sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err(invalid(
                    "credential hashes must contain 64 lowercase hexadecimal characters",
                ));
            }
            if !hashes.insert(&credential.sha256) {
                return Err(invalid("credential hashes must be unique"));
            }
            if credential
                .expires_at
                .as_deref()
                .is_some_and(|value| !valid_expiry(value))
            {
                return Err(invalid(
                    "expiry must be a UTC timestamp, for example 2027-01-01T00:00:00Z",
                ));
            }
        }
    }
    Ok(accounts)
}

fn generate_credential(
    account: &str,
    key: &str,
    secret: &[u8; 32],
    expiry: String,
) -> (String, Credential) {
    let secret = secret
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let token = format!("mhub_sa_{account}_{key}_{secret}");
    let credential = Credential {
        id: key.to_owned(),
        sha256: format!("{:x}", Sha256::digest(token.as_bytes())),
        expires_at: Some(expiry),
    };
    (token, credential)
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), Error> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

pub fn generate(
    account: &str,
    key: &str,
    output: &Path,
    config: Option<&Path>,
    days: u64,
) -> Result<(), Error> {
    validate_id(account)?;
    validate_id(key)?;
    if !(1..=3650).contains(&days) {
        return Err(Error::Usage(
            "--expires-in-days must be from 1 to 3650".into(),
        ));
    }
    let mut raw = Vec::new();
    let mut accounts = if let Some(path) = config {
        File::open(path)?
            .take((MAX_CONFIG_BYTES + 1) as u64)
            .read_to_end(&mut raw)?;
        parse_accounts(&raw)?
    } else {
        Vec::new()
    };
    let expiry = (OffsetDateTime::now_utc() + Duration::days(days as i64))
        .format(&Rfc3339)
        .map_err(|_| invalid("could not format expiry"))?;
    let mut secret = [0; 32];
    getrandom::fill(&mut secret)
        .map_err(|_| Error::Credential("could not generate a secure random token".into()))?;
    let (token, credential) = generate_credential(account, key, &secret, expiry);
    if let Some(existing) = accounts.iter_mut().find(|entry| entry.id == account) {
        if existing.credentials.iter().any(|entry| entry.id == key) {
            return Err(invalid(
                "credential ID already exists; use a new --key for rotation",
            ));
        }
        existing.credentials.push(credential);
    } else {
        accounts.push(Account {
            id: account.to_owned(),
            name: None,
            actions: vec!["org-integration.manage".into()],
            credentials: vec![credential],
        });
    }
    let json = format!("{}\n", serde_json::to_string_pretty(&accounts)?);
    parse_accounts(json.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().mode(0o700).create(output)?;
    }
    #[cfg(not(unix))]
    fs::create_dir(output)?;
    let result = write_private(&output.join("accounts.json"), json.as_bytes())
        .and_then(|()| write_private(&output.join("token"), format!("{token}\n").as_bytes()));
    if result.is_err() {
        let _ = fs::remove_dir_all(output);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../tests/fixtures/service-account.json")).unwrap()
    }

    #[test]
    fn generated_credential_matches_the_typescript_verifier_fixture() {
        let fixture = fixture();
        let expected = &fixture["accounts"][0]["credentials"][0];
        let (token, credential) = generate_credential(
            "ci-deploy",
            "initial",
            &[0x11; 32],
            expected["expires_at"].as_str().unwrap().to_owned(),
        );
        assert_eq!(token, fixture["token"].as_str().unwrap());
        assert_eq!(serde_json::to_value(credential).unwrap(), *expected);
        assert!(parse_accounts(fixture["accounts"].to_string().as_bytes()).is_ok());
    }

    #[test]
    fn rejects_null_optional_fields_unknown_fields_and_duplicate_actions() {
        for (field, value) in [
            ("name", Value::Null),
            ("unknown", json!("pasted-secret")),
            (
                "actions",
                json!(["org-integration.manage", "org-integration.manage"]),
            ),
        ] {
            let mut accounts = fixture()["accounts"].clone();
            accounts[0][field] = value;
            let error = parse_accounts(accounts.to_string().as_bytes())
                .err()
                .unwrap();
            assert!(!error.to_string().contains("pasted-secret"));
        }
        let mut accounts = fixture()["accounts"].clone();
        accounts[0]["credentials"][0]["expires_at"] = Value::Null;
        assert!(parse_accounts(accounts.to_string().as_bytes()).is_err());
    }

    #[test]
    fn validates_utc_expiry_without_rejecting_expired_rotation_keys() {
        for value in [
            "2020-01-01T00:00Z",
            "2020-01-01T00:00:00Z",
            "2030-01-01T00:00:00.123456789123Z",
        ] {
            assert!(valid_expiry(value), "{value}");
        }
        for value in [
            "2030-02-30T00:00:00Z",
            "2030-01-01T00:00:00+00:00",
            "2030-01-01t00:00:00Z",
            "2030-01-01T00:00:60Z",
            "2030-01-01T24:00:00Z",
            "2030-01-01T00:00:00",
        ] {
            assert!(!valid_expiry(value), "{value}");
        }
    }
}
