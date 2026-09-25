//! The pikepdf and MuPDF commands (`pdfbucket <command>`, src/pdfbucket/cli.py): each call is one
//! process that reads the PDF or bytes the server names and prints a PDF, a PNG or one JSON
//! document. A command that cannot read its PDF exits 3 with a StoreFailure document; any other
//! non-zero exit, a timeout or a spawn failure is a store failure with the command's stderr.
use std::os::unix::process::ExitStatusExt;
use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use axum::http::StatusCode;
use nix::errno::Errno;
use nix::sys::signal::{killpg, Signal};
use nix::unistd::Pid;
use serde::de::DeserializeOwned;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::config::{ProcessEnv, STORE_REFUSED_EXIT};
use crate::contract::{ApiErrorErrorKind, StoreFailure};
use crate::error::{AppError, AppResult};

/// Why a command did not print its answer.
#[derive(Debug)]
pub enum PdfFailure {
    /// The command could not read its PDF.
    Refused(StoreFailure),
    /// The command failed some other way: its exit and stderr.
    Crashed {
        status: ExitStatus,
        stderr: String,
    },
    TimedOut(Duration),
    Spawn(std::io::Error),
    /// Its standard input could not be written although it exited successfully.
    Stdin(std::io::Error),
    /// It printed a document outside its contract.
    Contract(serde_json::Error),
}

impl std::fmt::Display for PdfFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused(failure) => write!(formatter, "{}", *failure.message),
            Self::Crashed { status, stderr } => {
                write!(
                    formatter,
                    "the store command failed ({status}): {}",
                    stderr.trim()
                )
            }
            Self::TimedOut(limit) => write!(
                formatter,
                "the store command ran past its {} s limit and was killed",
                limit.as_secs()
            ),
            Self::Spawn(error) => write!(formatter, "the store command did not start: {error}"),
            Self::Stdin(error) => write!(formatter, "the store command's input failed: {error}"),
            Self::Contract(error) => {
                write!(
                    formatter,
                    "the store command printed an answer outside its contract: {error}"
                )
            }
        }
    }
}

impl From<PdfFailure> for AppError {
    fn from(failure: PdfFailure) -> Self {
        let (status, kind) = match &failure {
            PdfFailure::Refused(_) => (
                StatusCode::UNPROCESSABLE_ENTITY,
                ApiErrorErrorKind::UnreadablePdf,
            ),
            _ => (
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorErrorKind::StoreFailed,
            ),
        };
        AppError::api(status, kind, failure.to_string())
    }
}

/// The exit a process reports: its exit code, or the negated signal that ended it (as Python's
/// `subprocess` reports it).
pub fn exit_code(status: ExitStatus) -> i64 {
    match (status.code(), status.signal()) {
        (Some(code), _) => i64::from(code),
        (None, Some(signal)) => -i64::from(signal),
        (None, None) => unreachable!("a finished process has an exit code or a signal"),
    }
}

/// Runs WORK, the wait on a child started by `Python::command`, for at most LIMIT. Past the
/// limit the child's whole process group is killed (a plugin's own children with it) and the
/// answer is None.
pub async fn within<T>(
    child: Option<u32>,
    limit: Duration,
    work: impl std::future::Future<Output = T>,
) -> AppResult<Option<T>> {
    let Ok(done) = tokio::time::timeout(limit, work).await else {
        if let Some(pid) = child {
            let group = Pid::from_raw(i32::try_from(pid).map_err(AppError::internal)?);
            match killpg(group, Signal::SIGKILL) {
                Ok(()) | Err(Errno::ESRCH) => {}
                Err(errno) => {
                    return Err(AppError::internal(format!(
                        "cannot kill process group {group}: {errno}"
                    )))
                }
            }
        }
        return Ok(None);
    };
    Ok(Some(done))
}

/// The directory holding `pdfbucket` and the extraction plugins' entry points, with the
/// environment and the time limit every command runs with.
#[derive(Clone)]
pub struct Python {
    bin: PathBuf,
    env: ProcessEnv,
    timeout: Duration,
}

impl Python {
    pub fn new(bin: PathBuf, env: ProcessEnv, timeout: Duration) -> Self {
        Self { bin, env, timeout }
    }

    /// A command with the configured environment and the Python environment's bin directory
    /// first on PATH, so plugins named by entry point (`pdfbucket-mineru-precise`) resolve.
    pub fn command(&self, program: &str) -> Command {
        let mut command = Command::new(program);
        for (name, value) in &self.env {
            match value {
                Some(value) => command.env(name, value),
                None => command.env_remove(name),
            };
        }
        let inherited = match self.env.get("PATH") {
            Some(Some(path)) => Some(path.clone()),
            Some(None) => None,
            None => std::env::var_os("PATH").map(|path| path.to_string_lossy().into_owned()),
        };
        let path = match inherited {
            Some(rest) => format!("{}:{rest}", self.bin.display()),
            None => self.bin.display().to_string(),
        };
        command
            .env("PATH", path)
            .process_group(0)
            .kill_on_drop(true);
        command
    }

    /// Runs `pdfbucket ARGS`, STDIN on its standard input, and answers its stdout. Standard
    /// input is written while the output is read, so a command that exits early still reports
    /// its own failure and stderr.
    pub async fn run(&self, args: &[String], stdin: Option<&[u8]>) -> Result<Vec<u8>, PdfFailure> {
        let mut command = self.command(&self.bin.join("pdfbucket").to_string_lossy());
        command
            .args(args)
            .stdin(if stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().map_err(PdfFailure::Spawn)?;
        let pipe = child.stdin.take();
        let write = async move {
            match (pipe, stdin) {
                (Some(mut pipe), Some(bytes)) => pipe.write_all(bytes).await,
                _ => Ok(()),
            }
        };
        let finished = async { tokio::join!(write, child.wait_with_output()) };
        let (written, output) = tokio::time::timeout(self.timeout, finished)
            .await
            .map_err(|_elapsed| PdfFailure::TimedOut(self.timeout))?;
        let output = output.map_err(PdfFailure::Spawn)?;
        if output.status.code() == Some(STORE_REFUSED_EXIT) {
            let refused = serde_json::from_slice(&output.stdout).map_err(PdfFailure::Contract)?;
            return Err(PdfFailure::Refused(refused));
        }
        if !output.status.success() {
            return Err(PdfFailure::Crashed {
                status: output.status,
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            });
        }
        written.map_err(PdfFailure::Stdin)?;
        Ok(output.stdout)
    }

    pub async fn json<T: DeserializeOwned>(&self, args: &[String]) -> Result<T, PdfFailure> {
        let stdout = self.run(args, None).await?;
        serde_json::from_slice(&stdout).map_err(PdfFailure::Contract)
    }
}
