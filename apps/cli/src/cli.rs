use std::collections::{BTreeMap, BTreeSet};

use clap::{value_parser, Arg, ArgAction, Command, ValueHint};

use crate::manifest::{BodyProperty, Manifest, Operation, Parameter, ParameterLocation};

#[derive(Default)]
struct Node<'a> {
    operation: Option<&'a Operation>,
    children: BTreeMap<&'a str, Node<'a>>,
}

fn add_operation<'a>(node: &mut Node<'a>, operation: &'a Operation, depth: usize) {
    if depth == operation.command.len() {
        node.operation = Some(operation);
        return;
    }
    let child = node.children.entry(&operation.command[depth]).or_default();
    add_operation(child, operation, depth + 1);
}

fn parameter_arg(parameter: &Parameter) -> Option<Arg> {
    let lower = parameter.name.to_ascii_lowercase();
    if parameter.location == ParameterLocation::Header
        && (lower == "if-match" || lower == "idempotency-key")
    {
        return None;
    }
    let id = format!("parameter:{}", parameter.name);
    let mut arg = Arg::new(id)
        .long(parameter.cli_name.clone())
        .value_name(parameter.value_type.to_ascii_uppercase())
        .required(parameter.required)
        .action(if parameter.repeatable {
            ArgAction::Append
        } else {
            ArgAction::Set
        });
    if let Some(description) = &parameter.description {
        arg = arg.help(description.clone());
    }
    Some(arg)
}

fn body_arg(property: &BodyProperty, cli_name: String) -> Arg {
    let id = format!("body:{}", property.name);
    let mut arg = Arg::new(id)
        .long(cli_name)
        .value_name(property.value_type.to_ascii_uppercase())
        .action(if property.repeatable {
            ArgAction::Append
        } else {
            ArgAction::Set
        });
    if let Some(description) = &property.description {
        arg = arg.help(description.clone());
    }
    arg
}

fn operation_args(mut command: Command, operation: &Operation) -> Command {
    let mut used_cli_names = BTreeSet::from([
        "all".to_owned(),
        "base-url".to_owned(),
        "body".to_owned(),
        "idempotency-key".to_owned(),
        "if-match".to_owned(),
        "no-if-match".to_owned(),
        "no-update-check".to_owned(),
        "output".to_owned(),
        "profile".to_owned(),
        "raw-envelope".to_owned(),
        "timeout".to_owned(),
        "token".to_owned(),
        "token-file".to_owned(),
        "yes".to_owned(),
    ]);
    for parameter in &operation.parameters {
        if let Some(arg) = parameter_arg(parameter) {
            used_cli_names.insert(parameter.cli_name.clone());
            command = command.arg(arg);
        }
    }
    if let Some(body) = &operation.body {
        command = command.arg(
            Arg::new("raw-body")
                .long("body")
                .value_name("JSON|@FILE|-")
                .value_hint(ValueHint::FilePath)
                .help("Complete JSON request body; @FILE reads a file and - reads stdin"),
        );
        for property in &body.properties {
            let mut cli_name = property.cli_name.clone();
            while !used_cli_names.insert(cli_name.clone()) {
                cli_name = format!("body-{cli_name}");
            }
            command = command.arg(body_arg(property, cli_name));
        }
    }
    if operation.accepts_if_match {
        command = command
            .arg(
                Arg::new("if-match")
                    .long("if-match")
                    .value_name("ETAG")
                    .help("Use this ETag instead of fetching the current resource"),
            )
            .arg(
                Arg::new("no-if-match")
                    .long("no-if-match")
                    .action(ArgAction::SetTrue)
                    .conflicts_with("if-match")
                    .help("Skip optimistic concurrency protection"),
            );
    }
    if operation.accepts_idempotency_key {
        command = command.arg(
            Arg::new("idempotency-key")
                .long("idempotency-key")
                .value_name("KEY")
                .help("Override the generated idempotency key"),
        );
    }
    if operation.destructive {
        command = command.arg(
            Arg::new("yes")
                .short('y')
                .long("yes")
                .action(ArgAction::SetTrue)
                .help("Confirm the destructive operation"),
        );
    }
    if operation.paginated {
        command = command.arg(
            Arg::new("all")
                .long("all")
                .action(ArgAction::SetTrue)
                .help("Fetch every page"),
        );
    }
    command
}

fn command_from_node(name: &str, node: &Node<'_>) -> Command {
    let mut command = Command::new(name.to_owned());
    if let Some(operation) = node.operation {
        command = command.about(operation.summary.clone());
        if let Some(description) = &operation.description {
            command = command.long_about(description.clone());
        }
        command = operation_args(command, operation);
    }
    for (child_name, child) in &node.children {
        command = command.subcommand(command_from_node(child_name, child));
    }
    command
}

fn profile_command() -> Command {
    Command::new("profile")
        .about("Manage server profiles and native credentials")
        .subcommand_required(true)
        .subcommand(Command::new("list").about("List profiles"))
        .subcommand(
            Command::new("set")
                .about("Create or update a profile")
                .arg(Arg::new("name").required(true))
                .arg(
                    Arg::new("base-url")
                        .long("base-url")
                        .required(true)
                        .value_name("URL"),
                )
                .arg(
                    Arg::new("token-stdin")
                        .long("token-stdin")
                        .action(ArgAction::SetTrue)
                        .conflicts_with_all(["token", "token-file"])
                        .help("Read a token from stdin and store it in the OS credential store"),
                ),
        )
        .subcommand(
            Command::new("use")
                .about("Select the default profile")
                .arg(Arg::new("name").required(true)),
        )
        .subcommand(
            Command::new("remove")
                .about("Remove a profile and its stored credential")
                .arg(Arg::new("name").required(true)),
        )
}

fn login_command() -> Command {
    Command::new("login")
        .about("Sign in through the Hub UI and store the token securely")
        .arg(
            Arg::new("token-stdin")
                .long("token-stdin")
                .action(ArgAction::SetTrue)
                .conflicts_with_all(["token", "token-file"])
                .help("Read the token from stdin instead of an argument or file"),
        )
        .arg(
            Arg::new("no-browser")
                .long("no-browser")
                .action(ArgAction::SetTrue)
                .conflicts_with_all(["token-stdin", "token", "token-file"])
                .help("Print the sign-in URL for a browser on this machine"),
        )
}

pub fn build(manifest: &Manifest) -> Command {
    let mut root = Node::default();
    for operation in &manifest.operations {
        add_operation(&mut root, operation, 0);
    }

    let mut command = Command::new("mohub")
        .version(env!("CARGO_PKG_VERSION"))
        .about("Command-line client for marimohub")
        .subcommand_required(true)
        .arg_required_else_help(true)
        .arg(
            Arg::new("base-url")
                .long("base-url")
                .global(true)
                .env("MARIMOHUB_URL")
                .value_name("URL"),
        )
        .arg(
            Arg::new("profile-name")
                .long("profile")
                .global(true)
                .env("MARIMOHUB_PROFILE")
                .value_name("NAME"),
        )
        .arg(
            Arg::new("token")
                .long("token")
                .global(true)
                .env("MARIMOHUB_TOKEN")
                .hide_env_values(true)
                .conflicts_with("token-file")
                .value_name("TOKEN"),
        )
        .arg(
            Arg::new("token-file")
                .long("token-file")
                .global(true)
                .env("MARIMOHUB_TOKEN_FILE")
                .conflicts_with("token")
                .value_hint(ValueHint::FilePath)
                .value_name("PATH"),
        )
        .arg(
            Arg::new("timeout")
                .long("timeout")
                .global(true)
                .env("MARIMOHUB_TIMEOUT")
                .default_value("30")
                .value_parser(value_parser!(u64))
                .value_name("SECONDS"),
        )
        .arg(
            Arg::new("output")
                .long("output")
                .short('o')
                .global(true)
                .default_value("json")
                .value_parser(["json", "jsonl", "raw", "table", "csv"]),
        )
        .arg(
            Arg::new("raw-envelope")
                .long("raw-envelope")
                .global(true)
                .action(ArgAction::SetTrue)
                .help("Print the complete API response envelope"),
        )
        .arg(
            Arg::new("no-update-check")
                .long("no-update-check")
                .global(true)
                .env("MARIMOHUB_NO_UPDATE_CHECK")
                .action(ArgAction::SetTrue)
                .help("Do not check GitHub Releases for a newer mohub version"),
        )
        .subcommand(profile_command())
        .subcommand(login_command())
        .subcommand(
            Command::new("status").about("Validate authentication for the selected profile"),
        )
        .subcommand(
            Command::new("logout").about("Remove the stored token for the selected profile"),
        )
        .subcommand(
            Command::new("completions")
                .about("Generate shell completions")
                .arg(Arg::new("shell").required(true).value_parser([
                    "bash",
                    "elvish",
                    "fish",
                    "nushell",
                    "powershell",
                    "zsh",
                ])),
        );

    for (name, node) in &root.children {
        command = command.subcommand(command_from_node(name, node));
    }
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_command_tree_is_valid() {
        build(&crate::manifest::load()).debug_assert();
    }

    #[test]
    fn request_body_fields_do_not_shadow_reserved_flags() {
        let command = build(&crate::manifest::load());
        let operation = command
            .find_subcommand("openNotebookChangeRequest")
            .unwrap();
        let body = operation
            .get_arguments()
            .find(|argument| argument.get_id() == "body:body")
            .unwrap();

        assert_eq!(body.get_long(), Some("body-body"));
    }

    #[test]
    fn login_rejects_no_browser_with_token_supply_flags() {
        for arguments in [
            vec!["mohub", "login", "--no-browser", "--token-stdin"],
            vec!["mohub", "login", "--no-browser", "--token", "secret"],
            vec![
                "mohub",
                "login",
                "--no-browser",
                "--token-file",
                "token.txt",
            ],
        ] {
            let error = build(&crate::manifest::load())
                .try_get_matches_from(arguments)
                .expect_err("token supply flags must conflict with --no-browser");

            assert_eq!(error.kind(), clap::error::ErrorKind::ArgumentConflict);
        }
    }
}
