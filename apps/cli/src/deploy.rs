use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::client::{self, NotebookDeploymentState, Runtime};
use crate::deploy_config::{self, DeploymentConfig, DeploymentNotebook};
use crate::Error;

pub struct DeployOptions {
    pub config: Option<PathBuf>,
    pub notebooks: Vec<String>,
    pub dry_run: bool,
    pub message: Option<String>,
}

pub struct PreparedDeployment {
    config: DeploymentConfig,
    notebooks: Vec<String>,
    dry_run: bool,
    message: Option<String>,
}

#[derive(Debug)]
struct PlannedNotebook {
    name: String,
    notebook_id: String,
    etag: String,
    changes: Vec<String>,
    patch: Value,
}

#[derive(Debug, Serialize)]
struct NotebookResult {
    name: String,
    notebook_id: String,
    action: &'static str,
    changes: Vec<String>,
}

#[derive(Debug, Serialize)]
struct DeployResult {
    config: String,
    project_id: String,
    dry_run: bool,
    notebooks: Vec<NotebookResult>,
}

fn selected_notebooks<'a>(
    config: &'a DeploymentConfig,
    selectors: &[String],
) -> Result<Vec<(&'a String, &'a DeploymentNotebook)>, Error> {
    if selectors.is_empty() {
        return Ok(config.notebooks.iter().collect());
    }
    let selectors = selectors.iter().collect::<BTreeSet<_>>();
    let unknown = selectors
        .iter()
        .filter(|name| !config.notebooks.contains_key(name.as_str()))
        .map(|name| name.as_str())
        .collect::<Vec<_>>();
    if !unknown.is_empty() {
        return Err(Error::Usage(format!(
            "unknown notebook selection{} {}; available notebooks: {}",
            if unknown.len() == 1 { "" } else { "s" },
            unknown.join(", "),
            config
                .notebooks
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>()
                .join(", ")
        )));
    }
    Ok(config
        .notebooks
        .iter()
        .filter(|(name, _)| selectors.contains(name))
        .collect())
}

fn add_string_change(
    patch: &mut BTreeMap<String, Value>,
    field: &str,
    desired: Option<&String>,
    current: &str,
) {
    if let Some(desired) = desired.filter(|desired| desired.as_str() != current) {
        patch.insert(field.to_owned(), Value::String(desired.clone()));
    }
}

fn add_optional_string_change(
    patch: &mut BTreeMap<String, Value>,
    field: &str,
    desired: Option<&String>,
    current: Option<&str>,
) {
    let Some(desired) = desired else {
        return;
    };
    if desired == "default" {
        if current.is_some() {
            patch.insert(field.to_owned(), Value::Null);
        }
    } else if current != Some(desired) {
        patch.insert(field.to_owned(), Value::String(desired.clone()));
    }
}

fn plan_notebook(
    name: &str,
    local: &DeploymentNotebook,
    remote: NotebookDeploymentState,
    message: Option<&str>,
) -> Result<PlannedNotebook, Error> {
    if remote.source_type != "local" {
        return Err(Error::Deployment(format!(
            "notebook {name:?} ({}) is {}-backed; deploy supports only local notebooks",
            local.notebook_id, remote.source_type
        )));
    }

    let mut patch = BTreeMap::new();
    if local.code != remote.code {
        patch.insert("code".to_owned(), Value::String(local.code.clone()));
        patch.insert(
            "message".to_owned(),
            Value::String(
                message
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("Deploy {}", local.display_path)),
            ),
        );
    }
    add_string_change(&mut patch, "title", local.title.as_ref(), &remote.title);
    add_string_change(
        &mut patch,
        "description",
        local.description.as_ref(),
        &remote.description,
    );
    if local.tags.as_ref().is_some_and(|tags| tags != &remote.tags) {
        patch.insert(
            "tags".to_owned(),
            serde_json::to_value(local.tags.as_ref().expect("checked above"))?,
        );
    }
    if local
        .readme
        .as_ref()
        .is_some_and(|readme| Some(readme.as_str()) != remote.readme.as_deref())
    {
        patch.insert(
            "readme".to_owned(),
            Value::String(local.readme.clone().expect("checked above")),
        );
    }
    add_optional_string_change(
        &mut patch,
        "base_image",
        local.base_image.as_ref(),
        remote.base_image.as_deref(),
    );
    add_optional_string_change(
        &mut patch,
        "compute_profile",
        local.compute_profile.as_ref(),
        remote.compute_profile.as_deref(),
    );

    let changes = patch
        .keys()
        .filter(|field| field.as_str() != "message")
        .cloned()
        .collect();
    Ok(PlannedNotebook {
        name: name.to_owned(),
        notebook_id: local.notebook_id.clone(),
        etag: remote.etag,
        changes,
        patch: Value::Object(Map::from_iter(patch)),
    })
}

fn plan(
    runtime: &Runtime<'_>,
    config: &DeploymentConfig,
    selectors: &[String],
    message: Option<&str>,
) -> Result<Vec<PlannedNotebook>, Error> {
    selected_notebooks(config, selectors)?
        .into_iter()
        .map(|(name, notebook)| {
            let remote = client::notebook_deployment_state(
                runtime,
                &config.project_id,
                &notebook.notebook_id,
            )?;
            plan_notebook(name, notebook, remote, message)
        })
        .collect()
}

pub fn prepare(options: DeployOptions) -> Result<PreparedDeployment, Error> {
    let config = deploy_config::load(options.config.as_deref(), &options.notebooks)?;
    selected_notebooks(&config, &options.notebooks)?;
    Ok(PreparedDeployment {
        config,
        notebooks: options.notebooks,
        dry_run: options.dry_run,
        message: options.message,
    })
}

pub fn execute(runtime: &Runtime<'_>, prepared: PreparedDeployment) -> Result<(), Error> {
    let config = prepared.config;
    let planned = plan(
        runtime,
        &config,
        &prepared.notebooks,
        prepared.message.as_deref(),
    )?;
    let mut results = Vec::with_capacity(planned.len());
    let mut updated = Vec::new();

    for notebook in planned {
        let action = if notebook.changes.is_empty() {
            "unchanged"
        } else if prepared.dry_run {
            "planned"
        } else {
            if let Err(error) = client::update_notebook_deployment(
                runtime,
                &config.project_id,
                &notebook.notebook_id,
                &notebook.etag,
                &notebook.patch,
            ) {
                let applied = if updated.is_empty() {
                    "no earlier notebooks were updated".to_owned()
                } else {
                    format!("already updated: {}", updated.join(", "))
                };
                return Err(Error::Deployment(format!(
                    "could not update {:?}: {error}; {applied}",
                    notebook.name
                )));
            }
            updated.push(notebook.name.clone());
            "updated"
        };
        results.push(NotebookResult {
            name: notebook.name,
            notebook_id: notebook.notebook_id,
            action,
            changes: notebook.changes,
        });
    }

    let result = DeployResult {
        config: config.path.display().to_string(),
        project_id: config.project_id,
        dry_run: prepared.dry_run,
        notebooks: results,
    };
    client::write_output(&serde_json::to_value(result)?, runtime.output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local() -> DeploymentNotebook {
        DeploymentNotebook {
            notebook_id: "nb-7h2k9qm4xz7rp3w8".into(),
            display_path: "app.py".into(),
            code: "print('new')".into(),
            title: Some("New title".into()),
            description: None,
            tags: Some(vec!["production".into()]),
            readme: None,
            base_image: Some("default".into()),
            compute_profile: Some("large".into()),
        }
    }

    fn remote() -> NotebookDeploymentState {
        NotebookDeploymentState {
            title: "Old title".into(),
            description: "Description".into(),
            tags: vec![],
            readme: None,
            base_image: Some("custom".into()),
            compute_profile: None,
            source_type: "local".into(),
            code: "print('old')".into(),
            etag: "\"etag-1\"".into(),
        }
    }

    #[test]
    fn plan_contains_only_changed_fields_in_stable_order() {
        let plan = plan_notebook("app", &local(), remote(), None).unwrap();

        assert_eq!(
            plan.changes,
            ["base_image", "code", "compute_profile", "tags", "title"]
        );
        assert_eq!(plan.patch["base_image"], Value::Null);
        assert_eq!(plan.patch["message"], "Deploy app.py");
        assert_eq!(plan.patch["compute_profile"], "large");
        assert!(plan.patch.get("description").is_none());
    }

    #[test]
    fn matching_configured_values_produce_an_empty_patch() {
        let mut local = local();
        let remote = remote();
        local.code = remote.code.clone();
        local.title = Some(remote.title.clone());
        local.tags = Some(remote.tags.clone());
        local.base_image = None;
        local.compute_profile = None;

        let plan = plan_notebook("app", &local, remote, None).unwrap();
        assert!(plan.changes.is_empty());
        assert_eq!(plan.patch, serde_json::json!({}));
    }

    #[test]
    fn a_default_value_is_unchanged_when_remote_already_uses_the_default() {
        let mut local = local();
        local.code = "print('old')".into();
        local.title = None;
        local.tags = None;
        local.compute_profile = Some("default".into());
        let mut remote = remote();
        remote.base_image = None;

        let plan = plan_notebook("app", &local, remote, None).unwrap();
        assert!(plan.changes.is_empty());
    }

    #[test]
    fn remote_sources_are_rejected() {
        let mut remote = remote();
        remote.source_type = "git".into();
        let error = plan_notebook("app", &local(), remote, None).unwrap_err();
        assert!(error.to_string().contains("supports only local notebooks"));
    }

    #[test]
    fn explicit_message_replaces_the_default_version_message() {
        let plan = plan_notebook("app", &local(), remote(), Some("Release dashboard")).unwrap();
        assert_eq!(plan.patch["message"], "Release dashboard");
    }

    #[test]
    fn metadata_only_changes_never_add_code_or_a_version_message() {
        let remote = remote();
        let mut local = local();
        local.code = remote.code.clone();
        local.title = Some("Only metadata changed".into());
        local.tags = None;
        local.base_image = None;
        local.compute_profile = None;

        let plan = plan_notebook("app", &local, remote, Some("Ignored message")).unwrap();
        assert_eq!(plan.changes, ["title"]);
        assert_eq!(plan.patch["title"], "Only metadata changed");
        assert!(plan.patch.get("code").is_none());
        assert!(plan.patch.get("message").is_none());
    }

    #[test]
    fn empty_metadata_and_tag_order_are_meaningful_changes() {
        let mut remote = remote();
        remote.tags = vec!["one".into(), "two".into()];
        remote.readme = Some("Old readme".into());
        let mut local = local();
        local.code = remote.code.clone();
        local.title = None;
        local.description = Some(String::new());
        local.tags = Some(vec!["two".into(), "one".into()]);
        local.readme = Some(String::new());
        local.base_image = None;
        local.compute_profile = None;

        let plan = plan_notebook("app", &local, remote, None).unwrap();
        assert_eq!(plan.changes, ["description", "readme", "tags"]);
        assert_eq!(plan.patch["description"], "");
        assert_eq!(plan.patch["readme"], "");
        assert_eq!(plan.patch["tags"], serde_json::json!(["two", "one"]));
    }

    #[test]
    fn default_clears_both_remote_overrides() {
        let mut remote = remote();
        remote.compute_profile = Some("large".into());
        let mut local = local();
        local.code = remote.code.clone();
        local.title = None;
        local.tags = None;
        local.base_image = Some("default".into());
        local.compute_profile = Some("default".into());

        let plan = plan_notebook("app", &local, remote, None).unwrap();
        assert_eq!(plan.changes, ["base_image", "compute_profile"]);
        assert_eq!(plan.patch["base_image"], Value::Null);
        assert_eq!(plan.patch["compute_profile"], Value::Null);
    }

    #[test]
    fn only_lowercase_default_is_the_clear_sentinel() {
        let remote = remote();
        let mut local = local();
        local.code = remote.code.clone();
        local.title = None;
        local.tags = None;
        local.base_image = Some("Default".into());
        local.compute_profile = None;

        let plan = plan_notebook("app", &local, remote, None).unwrap();
        assert_eq!(plan.patch["base_image"], "Default");
    }

    #[test]
    fn selectors_are_validated_and_sorted_by_config_key() {
        let mut notebooks = BTreeMap::new();
        notebooks.insert("zebra".into(), local());
        notebooks.insert("alpha".into(), local());
        let config = DeploymentConfig {
            path: PathBuf::from("marimohub.toml"),
            project_id: "proj-7h2k9qm4xz7rp3w8".into(),
            notebooks,
        };

        let selected = selected_notebooks(&config, &["zebra".into(), "alpha".into()]).unwrap();
        assert_eq!(
            selected
                .into_iter()
                .map(|(name, _)| name.as_str())
                .collect::<Vec<_>>(),
            ["alpha", "zebra"]
        );
        assert!(selected_notebooks(&config, &["missing".into()])
            .unwrap_err()
            .to_string()
            .contains("available notebooks: alpha, zebra"));

        let selected = selected_notebooks(&config, &["zebra".into(), "zebra".into()]).unwrap();
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].0, "zebra");
    }
}
