// The environment of the commands the bucket runs (the Python store, the plugins): the PATH of
// this binary's build, so they find the tools the build used (uv, bun), and the changes the
// checkout's `.envrc` makes, which carry the extraction providers' keys.
use std::fmt;
use std::path::Path;
use std::process::{Command, ExitStatus};

use pdf_bucket::config::{ProcessEnv, CHECKOUT};

const BUILD_PATH: &str = env!("PDF_BUCKET_BUILD_PATH");

// Why the checkout's `.envrc` could not be read.
pub enum EnvrcFailure {
    DirenvMissing(std::io::Error),
    Refused { status: ExitStatus, stderr: String },
    NotJson(serde_json::Error),
}

impl fmt::Display for EnvrcFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DirenvMissing(error) => write!(formatter, "direnv could not run: {error}."),
            Self::Refused { status, stderr } => write!(
                formatter,
                "direnv could not load {CHECKOUT}/.envrc ({status}).\n\n{stderr}"
            ),
            Self::NotJson(error) => write!(
                formatter,
                "direnv printed an environment that is not JSON: {error}."
            ),
        }
    }
}

// The changes the checkout's `.envrc` makes, from `direnv export json` (the interface editor
// integrations use), on top of the build's PATH.
pub fn process_env() -> Result<ProcessEnv, EnvrcFailure> {
    let output = Command::new("direnv")
        .args(["export", "json"])
        .current_dir(Path::new(CHECKOUT))
        .env("PATH", BUILD_PATH)
        .output()
        .map_err(EnvrcFailure::DirenvMissing)?;
    if !output.status.success() {
        return Err(EnvrcFailure::Refused {
            status: output.status,
            stderr: strip_ansi_escapes::strip_str(String::from_utf8_lossy(&output.stderr)),
        });
    }
    let mut env = ProcessEnv::from([("PATH".to_string(), Some(BUILD_PATH.to_string()))]);
    // direnv prints nothing when the `.envrc` changes nothing.
    if !output.stdout.is_empty() {
        let changes: ProcessEnv =
            serde_json::from_slice(&output.stdout).map_err(EnvrcFailure::NotJson)?;
        env.extend(changes);
    }
    Ok(env)
}
