use std::fs;
use std::io;
use std::path::PathBuf;

use clap_complete::{generate_to, Shell};

fn main() -> io::Result<()> {
    let output = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("target/generated-assets"));
    let completions = output.join("completions");
    let manpages = output.join("man");
    fs::create_dir_all(&completions)?;
    fs::create_dir_all(&manpages)?;

    let manifest = mohub::manifest::load();
    for shell in [
        Shell::Bash,
        Shell::Elvish,
        Shell::Fish,
        Shell::PowerShell,
        Shell::Zsh,
    ] {
        generate_to(
            shell,
            &mut mohub::cli::build(&manifest),
            "mohub",
            &completions,
        )?;
    }
    generate_to(
        clap_complete_nushell::Nushell,
        &mut mohub::cli::build(&manifest),
        "mohub",
        &completions,
    )?;
    clap_mangen::generate_to(mohub::cli::build(&manifest), &manpages)?;
    Ok(())
}
