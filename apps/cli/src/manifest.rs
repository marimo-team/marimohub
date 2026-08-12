use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct Manifest {
    pub version: u32,
    pub api_version: String,
    pub operations: Vec<Operation>,
}

#[derive(Debug, Deserialize)]
pub struct Operation {
    pub id: String,
    pub command: Vec<String>,
    pub method: String,
    pub path: String,
    pub summary: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub parameters: Vec<Parameter>,
    #[serde(default)]
    pub body: Option<Body>,
    pub destructive: bool,
    pub paginated: bool,
    pub response_kind: ResponseKind,
    pub session_only: bool,
    pub accepts_if_match: bool,
    pub accepts_idempotency_key: bool,
    #[serde(default)]
    pub preflight_operation_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct Parameter {
    pub name: String,
    pub cli_name: String,
    #[serde(rename = "in")]
    pub location: ParameterLocation,
    pub required: bool,
    #[serde(default)]
    pub description: Option<String>,
    pub value_type: String,
    pub repeatable: bool,
}

#[derive(Debug, Deserialize)]
pub struct Body {
    pub required: bool,
    pub properties: Vec<BodyProperty>,
}

#[derive(Debug, Deserialize)]
pub struct BodyProperty {
    pub name: String,
    pub cli_name: String,
    pub required: bool,
    #[serde(default)]
    pub description: Option<String>,
    pub value_type: String,
    pub repeatable: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ParameterLocation {
    Path,
    Query,
    Header,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ResponseKind {
    Json,
    Raw,
}

pub fn load() -> Manifest {
    let manifest: Manifest = serde_json::from_slice(include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/generated/cli-manifest.json"
    )))
    .expect("embedded CLI manifest must be valid JSON");
    assert_eq!(manifest.version, 1, "unsupported embedded CLI manifest");
    assert!(
        !manifest.api_version.is_empty(),
        "manifest API version is empty"
    );
    manifest
}
