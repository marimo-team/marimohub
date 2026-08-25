pub mod cli;
pub mod client;
pub mod config;
pub mod deploy;
pub mod deploy_config;
pub mod manifest;

use std::io;

use miette::Diagnostic;
use thiserror::Error;

#[derive(Debug, Diagnostic, Error)]
pub enum Error {
    #[error("{0}")]
    #[diagnostic(code(mohub::usage))]
    Usage(String),
    #[error("configuration error: {0}")]
    #[diagnostic(code(mohub::configuration))]
    Config(String),
    #[error("credential store error: {0}")]
    #[diagnostic(code(mohub::credential_store))]
    Credential(String),
    #[error("manifest error: {0}")]
    #[diagnostic(code(mohub::manifest))]
    Manifest(String),
    #[error("{0}")]
    #[diagnostic(code(mohub::http))]
    Http(String),
    #[error("authentication failed for {server}: {reason}")]
    #[diagnostic(
        code(mohub::authentication),
        help("Run `mohub login` again, or use `mohub login --token-stdin` with an API token.")
    )]
    Authentication { server: String, reason: String },
    #[error("operation cancelled")]
    #[diagnostic(code(mohub::cancelled))]
    Cancelled,
    #[error("deployment failed: {0}")]
    #[diagnostic(code(mohub::deployment))]
    Deployment(String),
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Csv(#[from] csv::Error),
    #[error(transparent)]
    Url(#[from] url::ParseError),
    #[error("network error: {0}")]
    #[diagnostic(code(mohub::network))]
    Transport(String),
    #[error("terminal prompt error: {0}")]
    #[diagnostic(code(mohub::prompt))]
    Prompt(String),
}

impl From<ureq::Error> for Error {
    fn from(error: ureq::Error) -> Self {
        Self::Transport(error.to_string())
    }
}
