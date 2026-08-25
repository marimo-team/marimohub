use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer};

use crate::Error;

const CONFIG_FILE: &str = "marimohub.toml";
const PYPROJECT_FILE: &str = "pyproject.toml";

#[derive(Clone, Debug)]
pub struct DeploymentConfig {
    pub path: PathBuf,
    pub project_id: String,
    pub notebooks: BTreeMap<String, DeploymentNotebook>,
}

#[derive(Clone, Debug)]
pub struct DeploymentNotebook {
    pub notebook_id: String,
    pub display_path: String,
    pub code: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub tags: Option<Vec<String>>,
    pub readme: Option<String>,
    pub base_image: Option<DeploymentOverride>,
    pub compute_profile: Option<DeploymentOverride>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DeploymentOverride {
    Name(String),
    Clear,
}

impl<'de> Deserialize<'de> for DeploymentOverride {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct OverrideVisitor;

        impl Visitor<'_> for OverrideVisitor {
            type Value = DeploymentOverride;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a name or false to clear the override")
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(DeploymentOverride::Name(value.to_owned()))
            }

            fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(DeploymentOverride::Name(value))
            }

            fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                if value {
                    Err(E::invalid_value(de::Unexpected::Bool(value), &self))
                } else {
                    Ok(DeploymentOverride::Clear)
                }
            }
        }

        deserializer.deserialize_any(OverrideVisitor)
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawConfig {
    project_id: String,
    notebook_id: Option<String>,
    path: Option<PathBuf>,
    title: Option<String>,
    description: Option<String>,
    tags: Option<Vec<String>>,
    readme_path: Option<PathBuf>,
    base_image: Option<DeploymentOverride>,
    compute_profile: Option<DeploymentOverride>,
    #[serde(default)]
    notebooks: BTreeMap<String, RawNotebook>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawNotebook {
    notebook_id: String,
    path: Option<PathBuf>,
    title: Option<String>,
    description: Option<String>,
    tags: Option<Vec<String>>,
    readme_path: Option<PathBuf>,
    base_image: Option<DeploymentOverride>,
    compute_profile: Option<DeploymentOverride>,
}

fn config_error(path: &Path, message: impl std::fmt::Display) -> Error {
    Error::Config(format!("{}: {message}", path.display()))
}

fn read_toml(path: &Path) -> Result<toml::Value, Error> {
    let source = fs::read_to_string(path)
        .map_err(|error| config_error(path, format!("could not read configuration: {error}")))?;
    toml::from_str(&source).map_err(|error| config_error(path, error))
}

fn pyproject_config(value: &toml::Value) -> Option<toml::Value> {
    value
        .get("tool")
        .and_then(|tool| tool.get("marimohub"))
        .cloned()
}

fn parse_raw(path: &Path) -> Result<RawConfig, Error> {
    let value = read_toml(path)?;
    let config = if path.file_name() == Some(OsStr::new(PYPROJECT_FILE)) {
        pyproject_config(&value)
            .ok_or_else(|| config_error(path, "missing required [tool.marimohub] configuration"))?
    } else {
        value
    };
    config.try_into().map_err(|error| config_error(path, error))
}

fn has_pyproject_config(path: &Path) -> Result<bool, Error> {
    Ok(pyproject_config(&read_toml(path)?).is_some())
}

fn absolute_existing_config(path: &Path, cwd: &Path) -> Result<PathBuf, Error> {
    let candidate = if path.is_absolute() {
        path.to_owned()
    } else {
        cwd.join(path)
    };
    fs::canonicalize(&candidate).map_err(|error| {
        config_error(
            &candidate,
            format!("could not resolve configuration file: {error}"),
        )
    })
}

fn discover_from(
    cwd: &Path,
    explicit: Option<&Path>,
    environment: Option<&OsStr>,
) -> Result<PathBuf, Error> {
    if let Some(path) = explicit {
        return absolute_existing_config(path, cwd);
    }
    if let Some(path) = environment {
        if path.is_empty() {
            return Err(Error::Config("MARIMOHUB_CONFIG cannot be empty".into()));
        }
        return absolute_existing_config(Path::new(path), cwd);
    }

    for directory in cwd.ancestors() {
        let standalone = directory.join(CONFIG_FILE);
        if standalone.is_file() {
            return absolute_existing_config(&standalone, cwd);
        }
        let pyproject = directory.join(PYPROJECT_FILE);
        if pyproject.is_file() && has_pyproject_config(&pyproject)? {
            return absolute_existing_config(&pyproject, cwd);
        }
    }
    Err(Error::Config(format!(
        "no {CONFIG_FILE} or [tool.marimohub] configuration found from {} to the filesystem root",
        cwd.display()
    )))
}

fn require_nonempty(path: &Path, field: &str, value: String) -> Result<String, Error> {
    if value.trim().is_empty() {
        Err(config_error(path, format!("{field} cannot be empty")))
    } else {
        Ok(value)
    }
}

fn reject_empty(path: &Path, field: &str, value: Option<&str>) -> Result<(), Error> {
    if value == Some("") {
        Err(config_error(path, format!("{field} cannot be empty")))
    } else {
        Ok(())
    }
}

fn require_relative(path: &Path, field: &str, value: PathBuf) -> Result<PathBuf, Error> {
    if value.is_absolute() {
        Err(config_error(path, format!("{field} must be relative")))
    } else {
        Ok(value)
    }
}

fn read_utf8(config_path: &Path, path: &Path, label: &str) -> Result<String, Error> {
    let metadata = fs::metadata(path).map_err(|error| {
        config_error(
            config_path,
            format!("could not inspect {label} {}: {error}", path.display()),
        )
    })?;
    if !metadata.is_file() {
        return Err(config_error(
            config_path,
            format!("{label} {} is not a regular file", path.display()),
        ));
    }
    fs::read_to_string(path).map_err(|error| {
        config_error(
            config_path,
            format!(
                "could not read {label} {} as UTF-8: {error}",
                path.display()
            ),
        )
    })
}

fn inferred_python_path(config_path: &Path) -> Result<PathBuf, Error> {
    let directory = config_path
        .parent()
        .expect("canonical configuration path has a parent");
    let mut candidates = Vec::new();
    for entry in fs::read_dir(directory).map_err(|error| {
        config_error(
            config_path,
            format!("could not inspect {}: {error}", directory.display()),
        )
    })? {
        let entry = entry.map_err(|error| config_error(config_path, error))?;
        if entry
            .file_type()
            .map_err(|error| config_error(config_path, error))?
            .is_file()
            && entry.path().extension() == Some(OsStr::new("py"))
        {
            candidates.push(PathBuf::from(entry.file_name()));
        }
    }
    candidates.sort();
    match candidates.as_slice() {
        [only] => Ok(only.clone()),
        [] => Err(config_error(
            config_path,
            "no Python file was found; set path for the notebook",
        )),
        _ => Err(config_error(
            config_path,
            format!(
                "more than one Python file was found ({}); set path for the notebook",
                candidates
                    .iter()
                    .map(|path| path.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        )),
    }
}

fn restrict_to_selectors(
    raw_notebooks: &mut BTreeMap<String, RawNotebook>,
    selectors: &[String],
) -> Result<(), Error> {
    if selectors.is_empty() {
        return Ok(());
    }

    let selectors = selectors.iter().collect::<std::collections::BTreeSet<_>>();
    let unknown = selectors
        .iter()
        .filter(|name| !raw_notebooks.contains_key(name.as_str()))
        .map(|name| name.as_str())
        .collect::<Vec<_>>();
    if !unknown.is_empty() {
        return Err(Error::Usage(format!(
            "unknown notebook selection{} {}; available notebooks: {}",
            if unknown.len() == 1 { "" } else { "s" },
            unknown.join(", "),
            raw_notebooks
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>()
                .join(", ")
        )));
    }

    raw_notebooks.retain(|name, _| selectors.contains(name));
    Ok(())
}

fn resolve_selected(
    path: PathBuf,
    raw: RawConfig,
    selectors: &[String],
) -> Result<DeploymentConfig, Error> {
    let RawConfig {
        project_id,
        notebook_id,
        path: notebook_path,
        title,
        description,
        tags,
        readme_path,
        base_image,
        compute_profile,
        notebooks: mut raw_notebooks,
    } = raw;
    let project_id = require_nonempty(&path, "project_id", project_id)?;
    let has_flat_notebook_fields = notebook_id.is_some()
        || notebook_path.is_some()
        || title.is_some()
        || description.is_some()
        || tags.is_some()
        || readme_path.is_some()
        || base_image.is_some()
        || compute_profile.is_some();
    let uses_flat_notebook = raw_notebooks.is_empty();
    if uses_flat_notebook {
        let notebook_id = notebook_id.ok_or_else(|| {
            config_error(
                &path,
                "notebook_id is required when no named notebooks are declared",
            )
        })?;
        raw_notebooks.insert(
            "notebook".into(),
            RawNotebook {
                notebook_id,
                path: notebook_path,
                title,
                description,
                tags,
                readme_path,
                base_image,
                compute_profile,
            },
        );
    } else if has_flat_notebook_fields {
        return Err(config_error(
            &path,
            "top-level notebook fields cannot be combined with named notebooks",
        ));
    }
    let is_single = raw_notebooks.len() == 1;
    let mut notebook_ids = BTreeMap::new();
    for (name, notebook) in &raw_notebooks {
        if name.trim().is_empty() {
            return Err(config_error(&path, "notebook names cannot be empty"));
        }
        let field = |field_name: &str| {
            if uses_flat_notebook {
                field_name.to_owned()
            } else {
                format!("notebooks.{name}.{field_name}")
            }
        };
        if notebook.notebook_id.trim().is_empty() {
            return Err(config_error(
                &path,
                format!("{} cannot be empty", field("notebook_id")),
            ));
        }
        if let Some(existing_name) = notebook_ids.insert(notebook.notebook_id.as_str(), name) {
            return Err(config_error(
                &path,
                format!(
                    "{} duplicates notebooks.{existing_name}.notebook_id ({})",
                    field("notebook_id"),
                    notebook.notebook_id,
                ),
            ));
        }
        reject_empty(&path, &field("title"), notebook.title.as_deref())?;
        for (field_name, value) in [
            ("base_image", notebook.base_image.as_ref()),
            ("compute_profile", notebook.compute_profile.as_ref()),
        ] {
            let value = match value {
                Some(DeploymentOverride::Name(value)) => Some(value.as_str()),
                Some(DeploymentOverride::Clear) | None => None,
            };
            reject_empty(&path, &field(field_name), value)?;
        }
        if notebook
            .path
            .as_ref()
            .is_some_and(|value| value.is_absolute())
        {
            return Err(config_error(
                &path,
                format!("{} must be relative", field("path")),
            ));
        }
        if notebook
            .readme_path
            .as_ref()
            .is_some_and(|value| value.is_absolute())
        {
            return Err(config_error(
                &path,
                format!("{} must be relative", field("readme_path")),
            ));
        }
        if notebook.path.is_none() && !is_single {
            return Err(config_error(
                &path,
                format!(
                    "notebooks.{name}.path is required when more than one notebook is declared"
                ),
            ));
        }
    }
    restrict_to_selectors(&mut raw_notebooks, selectors)?;
    let directory = path
        .parent()
        .expect("canonical configuration path has a parent");
    let mut notebooks = BTreeMap::new();

    for (name, notebook) in raw_notebooks {
        let field = |field_name: &str| {
            if uses_flat_notebook {
                field_name.to_owned()
            } else {
                format!("notebooks.{name}.{field_name}")
            }
        };
        let notebook_id = require_nonempty(&path, &field("notebook_id"), notebook.notebook_id)?;
        let relative_path = match notebook.path {
            Some(notebook_path) => require_relative(&path, &field("path"), notebook_path)?,
            None if is_single => inferred_python_path(&path)?,
            None => {
                return Err(config_error(
                    &path,
                    format!(
                        "notebooks.{name}.path is required when more than one notebook is declared"
                    ),
                ))
            }
        };
        let source_path = directory.join(&relative_path);
        let code = read_utf8(&path, &source_path, "notebook")?;
        let readme = notebook
            .readme_path
            .map(|readme_path| {
                let readme_path = require_relative(&path, &field("readme_path"), readme_path)?;
                read_utf8(&path, &directory.join(readme_path), "readme")
            })
            .transpose()?;

        notebooks.insert(
            name,
            DeploymentNotebook {
                notebook_id,
                display_path: relative_path.display().to_string(),
                code,
                title: notebook.title,
                description: notebook.description,
                tags: notebook.tags,
                readme,
                base_image: notebook.base_image,
                compute_profile: notebook.compute_profile,
            },
        );
    }

    Ok(DeploymentConfig {
        path,
        project_id,
        notebooks,
    })
}

#[cfg(test)]
fn resolve(path: PathBuf, raw: RawConfig) -> Result<DeploymentConfig, Error> {
    resolve_selected(path, raw, &[])
}

pub fn load(explicit: Option<&Path>, selectors: &[String]) -> Result<DeploymentConfig, Error> {
    let cwd = std::env::current_dir()?;
    let path = discover_from(
        &cwd,
        explicit,
        std::env::var_os("MARIMOHUB_CONFIG").as_deref(),
    )?;
    let raw = parse_raw(&path)?;
    resolve_selected(path, raw, selectors)
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use tempfile::TempDir;

    use super::*;

    fn write(path: &Path, contents: &str) {
        fs::write(path, contents).expect("write fixture");
    }

    fn notebook_config(path: &str) -> String {
        format!(
            r#"project_id = "proj-7h2k9qm4xz7rp3w8"
notebook_id = "nb-7h2k9qm4xz7rp3w8"
path = "{path}"
"#
        )
    }

    #[test]
    fn standalone_and_pyproject_configs_resolve_the_same_shape() {
        let standalone_dir = TempDir::new().unwrap();
        write(&standalone_dir.path().join("app.py"), "print('standalone')");
        write(
            &standalone_dir.path().join(CONFIG_FILE),
            &notebook_config("app.py"),
        );
        let standalone_path = discover_from(standalone_dir.path(), None, None).unwrap();
        let standalone = resolve(
            standalone_path.clone(),
            parse_raw(&standalone_path).unwrap(),
        )
        .unwrap();

        let pyproject_dir = TempDir::new().unwrap();
        write(&pyproject_dir.path().join("app.py"), "print('pyproject')");
        write(
            &pyproject_dir.path().join(PYPROJECT_FILE),
            r#"[project]
name = "demo"

[tool.marimohub]
project_id = "proj-7h2k9qm4xz7rp3w8"
notebook_id = "nb-7h2k9qm4xz7rp3w8"
path = "app.py"
"#,
        );
        let pyproject_path = discover_from(pyproject_dir.path(), None, None).unwrap();
        let pyproject =
            resolve(pyproject_path.clone(), parse_raw(&pyproject_path).unwrap()).unwrap();

        assert_eq!(standalone.project_id, pyproject.project_id);
        assert_eq!(
            standalone.notebooks.keys().collect::<Vec<_>>(),
            vec!["notebook"]
        );
        assert_eq!(
            pyproject.notebooks.keys().collect::<Vec<_>>(),
            vec!["notebook"]
        );
    }

    #[test]
    fn pyproject_named_notebooks_use_the_tool_namespace() {
        let temp = TempDir::new().unwrap();
        write(&temp.path().join("alpha.py"), "alpha = 1");
        write(&temp.path().join("zebra.py"), "zebra = 1");
        write(
            &temp.path().join(PYPROJECT_FILE),
            r#"[tool.marimohub]
project_id = "proj-7h2k9qm4xz7rp3w8"

[tool.marimohub.notebooks.alpha]
notebook_id = "nb-7h2k9qm4xz7rp3w8"
path = "alpha.py"

[tool.marimohub.notebooks.zebra]
notebook_id = "nb-8h2k9qm4xz7rp3w8"
path = "zebra.py"
"#,
        );
        let path = temp.path().join(PYPROJECT_FILE).canonicalize().unwrap();

        let config = resolve(path.clone(), parse_raw(&path).unwrap()).unwrap();

        assert_eq!(
            config.notebooks.keys().collect::<Vec<_>>(),
            ["alpha", "zebra"]
        );
    }

    #[test]
    fn standalone_wins_over_a_colocated_pyproject() {
        let temp = TempDir::new().unwrap();
        write(&temp.path().join(CONFIG_FILE), &notebook_config("app.py"));
        write(
            &temp.path().join(PYPROJECT_FILE),
            "[tool.marimohub]\nproject_id = \"other\"\n",
        );

        assert_eq!(
            discover_from(temp.path(), None, None).unwrap(),
            temp.path().join(CONFIG_FILE).canonicalize().unwrap()
        );
    }

    #[test]
    fn explicit_then_environment_then_ancestor_discovery_sets_precedence() {
        let temp = TempDir::new().unwrap();
        let nested = temp.path().join("a/b");
        fs::create_dir_all(&nested).unwrap();
        let ancestor = temp.path().join(CONFIG_FILE);
        let environment = temp.path().join("environment.toml");
        let explicit = temp.path().join("explicit.toml");
        for path in [&ancestor, &environment, &explicit] {
            write(path, &notebook_config("app.py"));
        }

        assert_eq!(
            discover_from(&nested, Some(&explicit), Some(environment.as_os_str())).unwrap(),
            explicit.canonicalize().unwrap()
        );
        assert_eq!(
            discover_from(&nested, None, Some(environment.as_os_str())).unwrap(),
            environment.canonicalize().unwrap()
        );
        assert_eq!(
            discover_from(&nested, None, None).unwrap(),
            ancestor.canonicalize().unwrap()
        );
    }

    #[test]
    fn empty_environment_path_is_rejected() {
        let temp = TempDir::new().unwrap();
        let error =
            discover_from(temp.path(), None, Some(OsString::new().as_os_str())).unwrap_err();
        assert!(error
            .to_string()
            .contains("MARIMOHUB_CONFIG cannot be empty"));
    }

    #[test]
    fn single_notebook_infers_the_only_sibling_python_file() {
        let temp = TempDir::new().unwrap();
        write(&temp.path().join("only.py"), "print(1)");
        write(
            &temp.path().join(CONFIG_FILE),
            r#"project_id = "proj-7h2k9qm4xz7rp3w8"
notebook_id = "nb-7h2k9qm4xz7rp3w8"
"#,
        );
        let path = temp.path().join(CONFIG_FILE).canonicalize().unwrap();
        let config = resolve(path.clone(), parse_raw(&path).unwrap()).unwrap();

        assert_eq!(config.notebooks["notebook"].display_path, "only.py");
        assert_eq!(config.notebooks["notebook"].code, "print(1)");
    }

    #[test]
    fn omitted_path_reports_zero_and_multiple_candidates() {
        let temp = TempDir::new().unwrap();
        let config_path = temp.path().join(CONFIG_FILE);
        write(
            &config_path,
            r#"project_id = "proj-7h2k9qm4xz7rp3w8"
notebook_id = "nb-7h2k9qm4xz7rp3w8"
"#,
        );
        let path = config_path.canonicalize().unwrap();
        let error = resolve(path.clone(), parse_raw(&path).unwrap()).unwrap_err();
        assert!(error.to_string().contains("no Python file was found"));

        write(&temp.path().join("b.py"), "b = 1");
        write(&temp.path().join("a.py"), "a = 1");
        let error = resolve(path.clone(), parse_raw(&path).unwrap()).unwrap_err();
        let message = error.to_string();
        assert!(message.contains("more than one Python file was found (a.py, b.py)"));
    }

    #[test]
    fn every_entry_in_a_multi_notebook_config_requires_a_path() {
        let temp = TempDir::new().unwrap();
        write(&temp.path().join("a.py"), "a = 1");
        write(
            &temp.path().join(CONFIG_FILE),
            r#"project_id = "proj-7h2k9qm4xz7rp3w8"
[notebooks.a]
notebook_id = "nb-7h2k9qm4xz7rp3w8"
path = "a.py"
[notebooks.b]
notebook_id = "nb-8h2k9qm4xz7rp3w8"
"#,
        );
        let path = temp.path().join(CONFIG_FILE).canonicalize().unwrap();
        let error = resolve(path.clone(), parse_raw(&path).unwrap()).unwrap_err();
        assert!(error
            .to_string()
            .contains("notebooks.b.path is required when more than one notebook is declared"));
    }

    #[test]
    fn selectors_are_applied_before_local_files_are_read() {
        let temp = TempDir::new().unwrap();
        write(&temp.path().join("zebra.py"), "zebra = 2");
        write(
            &temp.path().join(CONFIG_FILE),
            r#"project_id = "proj-7h2k9qm4xz7rp3w8"
[notebooks.alpha]
notebook_id = "nb-7h2k9qm4xz7rp3w8"
path = "missing.py"
readme_path = "missing.md"
[notebooks.zebra]
notebook_id = "nb-8h2k9qm4xz7rp3w8"
path = "zebra.py"
"#,
        );
        let path = temp.path().join(CONFIG_FILE).canonicalize().unwrap();

        let config =
            resolve_selected(path.clone(), parse_raw(&path).unwrap(), &["zebra".into()]).unwrap();

        assert_eq!(config.notebooks.keys().collect::<Vec<_>>(), ["zebra"]);
        assert_eq!(config.notebooks["zebra"].code, "zebra = 2");
    }

    #[test]
    fn empty_server_constrained_values_are_rejected_before_file_reads() {
        let temp = TempDir::new().unwrap();
        let config_path = temp.path().join(CONFIG_FILE);
        let cases = [
            ("title", "title = \"\""),
            ("base_image", "base_image = \"\""),
            ("compute_profile", "compute_profile = \"\""),
        ];

        for (field, assignment) in cases {
            write(
                &config_path,
                &format!(
                    r#"project_id = "proj-7h2k9qm4xz7rp3w8"
[notebooks.app]
notebook_id = "nb-7h2k9qm4xz7rp3w8"
path = "missing.py"
{assignment}
"#,
                ),
            );
            let path = config_path.canonicalize().unwrap();

            let error = resolve(path.clone(), parse_raw(&path).unwrap()).unwrap_err();

            assert!(error
                .to_string()
                .contains(&format!("notebooks.app.{field} cannot be empty")));
            assert!(!error.to_string().contains("could not inspect notebook"));
        }

        write(&temp.path().join("app.py"), "print(1)");
        write(
            &config_path,
            r#"project_id = "proj-7h2k9qm4xz7rp3w8"
notebook_id = "nb-7h2k9qm4xz7rp3w8"
path = "app.py"
description = ""
"#,
        );
        let path = config_path.canonicalize().unwrap();
        let config = resolve(path.clone(), parse_raw(&path).unwrap()).unwrap();
        assert_eq!(
            config.notebooks["notebook"].description.as_deref(),
            Some("")
        );
    }

    #[test]
    fn duplicate_notebook_ids_are_rejected_before_selection_and_file_reads() {
        let temp = TempDir::new().unwrap();
        write(
            &temp.path().join(CONFIG_FILE),
            r#"project_id = "proj-7h2k9qm4xz7rp3w8"
[notebooks.alpha]
notebook_id = "nb-7h2k9qm4xz7rp3w8"
path = "missing-alpha.py"
[notebooks.zebra]
notebook_id = "nb-7h2k9qm4xz7rp3w8"
path = "missing-zebra.py"
"#,
        );
        let path = temp.path().join(CONFIG_FILE).canonicalize().unwrap();

        let error = resolve_selected(path.clone(), parse_raw(&path).unwrap(), &["zebra".into()])
            .unwrap_err();

        let message = error.to_string();
        assert!(message.contains(
            "notebooks.zebra.notebook_id duplicates notebooks.alpha.notebook_id (nb-7h2k9qm4xz7rp3w8)"
        ));
        assert!(!message.contains("could not inspect notebook"));
    }

    #[test]
    fn flat_and_named_notebook_forms_cannot_be_mixed() {
        let temp = TempDir::new().unwrap();
        let config_path = temp.path().join(CONFIG_FILE);
        write(
            &config_path,
            r#"project_id = "proj-7h2k9qm4xz7rp3w8"
notebook_id = "nb-7h2k9qm4xz7rp3w8"
[notebooks.other]
notebook_id = "nb-8h2k9qm4xz7rp3w8"
path = "other.py"
"#,
        );
        let path = config_path.canonicalize().unwrap();
        let error = resolve(path.clone(), parse_raw(&path).unwrap()).unwrap_err();
        assert!(error
            .to_string()
            .contains("top-level notebook fields cannot be combined with named notebooks"));

        write(&config_path, "project_id = \"proj-7h2k9qm4xz7rp3w8\"\n");
        let error = resolve(path.clone(), parse_raw(&path).unwrap()).unwrap_err();
        assert!(error
            .to_string()
            .contains("notebook_id is required when no named notebooks are declared"));
    }

    #[test]
    fn unknown_fields_and_absolute_paths_are_rejected() {
        let temp = TempDir::new().unwrap();
        let config_path = temp.path().join(CONFIG_FILE);
        write(
            &config_path,
            r#"project_id = "proj-7h2k9qm4xz7rp3w8"
typo = true
notebook_id = "nb-7h2k9qm4xz7rp3w8"
path = "app.py"
"#,
        );
        let path = config_path.canonicalize().unwrap();
        assert!(parse_raw(&path)
            .unwrap_err()
            .to_string()
            .contains("unknown field"));

        write(
            &config_path,
            r#"project_id = "proj-7h2k9qm4xz7rp3w8"
[notebooks.app]
notebook_id = "nb-7h2k9qm4xz7rp3w8"
path = "app.py"
typo = true
"#,
        );
        assert!(parse_raw(&path)
            .unwrap_err()
            .to_string()
            .contains("unknown field `typo`"));

        write(
            &config_path,
            &notebook_config(temp.path().join("app.py").to_str().unwrap()),
        );
        let error = resolve(path.clone(), parse_raw(&path).unwrap()).unwrap_err();
        assert!(error.to_string().contains("path must be relative"));
    }

    #[test]
    fn notebook_and_readme_paths_require_regular_utf8_files() {
        let temp = TempDir::new().unwrap();
        let config_path = temp.path().join(CONFIG_FILE);
        write(&config_path, &notebook_config("notebook"));
        fs::create_dir(temp.path().join("notebook")).unwrap();
        let path = config_path.canonicalize().unwrap();

        let error = resolve(path.clone(), parse_raw(&path).unwrap()).unwrap_err();
        assert!(error.to_string().contains("is not a regular file"));

        fs::remove_dir(temp.path().join("notebook")).unwrap();
        fs::write(temp.path().join("notebook"), [0xff]).unwrap();
        let error = resolve(path.clone(), parse_raw(&path).unwrap()).unwrap_err();
        assert!(error.to_string().contains("as UTF-8"));

        write(&temp.path().join("notebook"), "print(1)");
        write(
            &config_path,
            r#"project_id = "proj-7h2k9qm4xz7rp3w8"
notebook_id = "nb-7h2k9qm4xz7rp3w8"
path = "notebook"
readme_path = "readme.md"
"#,
        );
        fs::write(temp.path().join("readme.md"), [0xff]).unwrap();
        let error = resolve(path.clone(), parse_raw(&path).unwrap()).unwrap_err();
        assert!(error.to_string().contains("readme"));
        assert!(error.to_string().contains("as UTF-8"));
    }

    #[test]
    fn flat_optional_fields_are_resolved_without_defaults() {
        let temp = TempDir::new().unwrap();
        write(&temp.path().join("app.py"), "print(1)");
        write(&temp.path().join("README.md"), "Notebook docs");
        write(
            &temp.path().join(CONFIG_FILE),
            r#"project_id = "proj-7h2k9qm4xz7rp3w8"
notebook_id = "nb-7h2k9qm4xz7rp3w8"
path = "app.py"
title = "Dashboard"
description = "Description"
tags = ["one", "two"]
readme_path = "README.md"
base_image = "image"
compute_profile = "large"
"#,
        );
        let path = temp.path().join(CONFIG_FILE).canonicalize().unwrap();

        let config = resolve(path.clone(), parse_raw(&path).unwrap()).unwrap();
        let notebook = &config.notebooks["notebook"];
        assert_eq!(notebook.code, "print(1)");
        assert_eq!(notebook.title.as_deref(), Some("Dashboard"));
        assert_eq!(notebook.description.as_deref(), Some("Description"));
        assert_eq!(
            notebook.tags.as_deref(),
            Some(["one".into(), "two".into()].as_slice())
        );
        assert_eq!(notebook.readme.as_deref(), Some("Notebook docs"));
        assert_eq!(
            notebook.base_image,
            Some(DeploymentOverride::Name("image".into()))
        );
        assert_eq!(
            notebook.compute_profile,
            Some(DeploymentOverride::Name("large".into()))
        );
    }

    #[test]
    fn false_clears_overrides_and_default_remains_a_literal_name() {
        let temp = TempDir::new().unwrap();
        write(&temp.path().join("app.py"), "print(1)");
        write(
            &temp.path().join(CONFIG_FILE),
            r#"project_id = "proj-7h2k9qm4xz7rp3w8"
notebook_id = "nb-7h2k9qm4xz7rp3w8"
path = "app.py"
base_image = "default"
compute_profile = false
"#,
        );
        let path = temp.path().join(CONFIG_FILE).canonicalize().unwrap();

        let config = resolve(path.clone(), parse_raw(&path).unwrap()).unwrap();
        let notebook = &config.notebooks["notebook"];
        assert_eq!(
            notebook.base_image,
            Some(DeploymentOverride::Name("default".into()))
        );
        assert_eq!(notebook.compute_profile, Some(DeploymentOverride::Clear));
    }

    #[test]
    fn true_is_not_a_valid_override_value() {
        let temp = TempDir::new().unwrap();
        write(&temp.path().join("app.py"), "print(1)");
        write(
            &temp.path().join(CONFIG_FILE),
            r#"project_id = "proj-7h2k9qm4xz7rp3w8"
notebook_id = "nb-7h2k9qm4xz7rp3w8"
path = "app.py"
base_image = true
"#,
        );
        let path = temp.path().join(CONFIG_FILE).canonicalize().unwrap();

        let error = parse_raw(&path).unwrap_err();
        assert!(error
            .to_string()
            .contains("a name or false to clear the override"));
    }

    #[test]
    fn empty_required_ids_are_rejected() {
        let temp = TempDir::new().unwrap();
        write(&temp.path().join("app.py"), "print(1)");
        let config_path = temp.path().join(CONFIG_FILE);
        write(
            &config_path,
            "project_id = \"   \"\nnotebook_id = \"nb-7h2k9qm4xz7rp3w8\"\npath = \"app.py\"\n",
        );
        let path = config_path.canonicalize().unwrap();
        assert!(resolve(path.clone(), parse_raw(&path).unwrap())
            .unwrap_err()
            .to_string()
            .contains("project_id cannot be empty"));

        write(
            &config_path,
            "project_id = \"proj-7h2k9qm4xz7rp3w8\"\nnotebook_id = \"\"\npath = \"app.py\"\n",
        );
        assert!(resolve(path.clone(), parse_raw(&path).unwrap())
            .unwrap_err()
            .to_string()
            .contains("notebook_id cannot be empty"));
    }

    #[test]
    fn inference_ignores_nested_and_non_lowercase_python_files() {
        let temp = TempDir::new().unwrap();
        fs::create_dir(temp.path().join("nested")).unwrap();
        write(&temp.path().join("nested/child.py"), "print('nested')");
        write(&temp.path().join("upper.PY"), "print('upper')");
        write(&temp.path().join("notes.txt"), "notes");
        write(
            &temp.path().join(CONFIG_FILE),
            "project_id = \"proj-7h2k9qm4xz7rp3w8\"\nnotebook_id = \"nb-7h2k9qm4xz7rp3w8\"\n",
        );
        let path = temp.path().join(CONFIG_FILE).canonicalize().unwrap();

        assert!(resolve(path.clone(), parse_raw(&path).unwrap())
            .unwrap_err()
            .to_string()
            .contains("no Python file was found"));
        write(&temp.path().join("app.py"), "print('app')");
        let config = resolve(path.clone(), parse_raw(&path).unwrap()).unwrap();
        assert_eq!(config.notebooks["notebook"].display_path, "app.py");
    }

    #[test]
    fn one_named_notebook_can_use_path_inference() {
        let temp = TempDir::new().unwrap();
        write(&temp.path().join("app.py"), "print(1)");
        write(
            &temp.path().join(CONFIG_FILE),
            r#"project_id = "proj-7h2k9qm4xz7rp3w8"
[notebooks.app]
notebook_id = "nb-7h2k9qm4xz7rp3w8"
"#,
        );
        let path = temp.path().join(CONFIG_FILE).canonicalize().unwrap();

        let config = resolve(path.clone(), parse_raw(&path).unwrap()).unwrap();
        assert_eq!(config.notebooks["app"].display_path, "app.py");
    }

    #[test]
    fn explicit_pyproject_requires_the_tool_section_but_other_names_use_the_root() {
        let temp = TempDir::new().unwrap();
        let pyproject = temp.path().join(PYPROJECT_FILE);
        write(&pyproject, "[project]\nname = \"demo\"\n");
        assert!(parse_raw(&pyproject)
            .unwrap_err()
            .to_string()
            .contains("missing required [tool.marimohub]"));

        let custom = temp.path().join("deploy.toml");
        write(&custom, &notebook_config("app.py"));
        let raw = parse_raw(&custom).unwrap();
        assert_eq!(raw.project_id, "proj-7h2k9qm4xz7rp3w8");
        assert_eq!(raw.notebook_id.as_deref(), Some("nb-7h2k9qm4xz7rp3w8"));
    }

    #[test]
    fn nearest_pyproject_beats_a_parent_standalone_config() {
        let temp = TempDir::new().unwrap();
        let child = temp.path().join("child");
        fs::create_dir(&child).unwrap();
        write(
            &temp.path().join(CONFIG_FILE),
            &notebook_config("parent.py"),
        );
        write(
            &child.join(PYPROJECT_FILE),
            r#"[tool.marimohub]
project_id = "proj-7h2k9qm4xz7rp3w8"
notebook_id = "nb-7h2k9qm4xz7rp3w8"
path = "child.py"
"#,
        );

        assert_eq!(
            discover_from(&child, None, None).unwrap(),
            child.join(PYPROJECT_FILE).canonicalize().unwrap()
        );
    }

    #[test]
    fn schema_version_is_rejected_as_an_unknown_field() {
        let temp = TempDir::new().unwrap();
        write(&temp.path().join("app.py"), "print(1)");
        write(
            &temp.path().join(CONFIG_FILE),
            &format!("schema_version = 1\n{}", notebook_config("app.py")),
        );
        let path = temp.path().join(CONFIG_FILE).canonicalize().unwrap();

        let error = parse_raw(&path).unwrap_err();
        assert!(error.to_string().contains("unknown field `schema_version`"));
    }
}
