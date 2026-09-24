// The bucket server as this app's child process, like Zotero's connector server: it runs while
// the app runs. The app starts it, waits for `/status`, stops it on exit, and shows its exit
// status and last stderr lines in the window when it stops on its own.
use std::collections::{HashMap, VecDeque};
use std::io::{self, BufRead, BufReader, Write};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

// The checkout the binary was built from, and the PATH of that build: the server runs from
// that checkout with the tools (direnv, bun, uv) the build itself used.
const CHECKOUT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
const BUILD_PATH: &str = env!("PDF_BUCKET_BUILD_PATH");
// How long the window waits for a starting server: 30 one-second attempts.
const READY_ATTEMPTS: u32 = 30;
const READY_DELAY: Duration = Duration::from_secs(1);
const STDERR_LINES: usize = 40;

// Why the server is not serving.
pub struct Failure(pub String);

pub struct Server {
    pid: libc::pid_t,
    stopping: Arc<AtomicBool>,
    // False once the server has exited; its pid then no longer names the server.
    running: Arc<Mutex<bool>>,
    exited: Mutex<Receiver<()>>,
}

impl Server {
    // Starts `bun run src/server/index.ts` in the checkout with the environment the checkout's
    // `.envrc` sets, so the provider keys reach the extraction plugins. ON_STOP runs once if
    // the server exits while the app is still running.
    pub fn start(on_stop: impl FnOnce(Failure) + Send + 'static) -> Result<Server, Failure> {
        let mut command = Command::new("bun");
        command
            .args(["run", "src/server/index.ts"])
            .current_dir(Path::new(CHECKOUT))
            .env("PATH", BUILD_PATH)
            .env("NODE_ENV", "production")
            .stderr(Stdio::piped());
        for (name, value) in envrc_changes()? {
            match value {
                Some(value) => command.env(name, value),
                None => command.env_remove(name),
            };
        }
        // prctl(2) PR_SET_PDEATHSIG: the kernel sends SIGTERM to the server when the thread
        // that spawned it (the main thread) dies, so a killed or crashed app never leaves the
        // server holding the port.
        unsafe {
            command.pre_exec(|| {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) == -1 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command
            .spawn()
            .map_err(|error| Failure(format!("The server could not start: {error}.")))?;
        let pid = libc::pid_t::try_from(child.id()).expect("a Linux pid fits in pid_t");
        let (stderr, reader) = forward_stderr(&mut child);
        let stopping = Arc::new(AtomicBool::new(false));
        let running = Arc::new(Mutex::new(true));
        let (exited_tx, exited) = mpsc::channel();
        let watched = Arc::clone(&stopping);
        let reaped = Arc::clone(&running);
        thread::spawn(move || {
            // waitid(2) with WNOWAIT waits for the exit but leaves the zombie, so the pid cannot
            // be reused while `stop` may still signal it; the server is marked stopped under
            // the lock `stop` holds, and only then reaped.
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            let id = libc::id_t::try_from(pid).expect("a pid is a non-negative id_t");
            if unsafe { libc::waitid(libc::P_PID, id, &mut info, libc::WEXITED | libc::WNOWAIT) }
                == -1
            {
                panic!(
                    "waiting for the server failed: {}",
                    io::Error::last_os_error()
                );
            }
            *reaped.lock().expect("server state lock") = false;
            let status = child.wait();
            reader
                .join()
                .expect("the stderr reader finishes when the pipe closes");
            let tail = stderr.lock().expect("stderr buffer lock").clone();
            if !watched.load(Ordering::SeqCst) {
                on_stop(Failure(describe(status, &tail)));
            }
            exited_tx
                .send(())
                .expect("the app waits for the server's exit");
        });
        Ok(Server {
            pid,
            stopping,
            running,
            exited: Mutex::new(exited),
        })
    }

    // Sends SIGTERM to a running server and waits for it to exit, so its port is free when the
    // app is gone. A server that already stopped was reported when it did.
    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        let running = self.running.lock().expect("server state lock");
        if *running && unsafe { libc::kill(self.pid, libc::SIGTERM) } == -1 {
            panic!(
                "SIGTERM to the server failed: {}",
                io::Error::last_os_error()
            );
        }
        drop(running);
        self.exited
            .lock()
            .expect("server exit lock")
            .recv()
            .expect("the server watcher reports its exit");
    }
}

// The environment changes the checkout's `.envrc` makes, from `direnv export json` (the
// interface editor integrations use). `direnv exec` is not used because the process it execs
// loses PR_SET_PDEATHSIG: `setpriv --pdeathsig TERM -- direnv exec . sleep 1000` outlives its
// parent, while `setpriv --pdeathsig TERM -- sleep 1000` does not.
fn envrc_changes() -> Result<HashMap<String, Option<String>>, Failure> {
    let output = Command::new("direnv")
        .args(["export", "json"])
        .current_dir(Path::new(CHECKOUT))
        .env("PATH", BUILD_PATH)
        .output()
        .map_err(|error| Failure(format!("direnv could not run: {error}.")))?;
    if !output.status.success() {
        return Err(Failure(format!(
            "direnv could not load {CHECKOUT}/.envrc ({}).\n\n{}",
            output.status,
            strip_ansi_escapes::strip_str(String::from_utf8_lossy(&output.stderr))
        )));
    }
    // direnv prints nothing when the `.envrc` changes nothing.
    if output.stdout.is_empty() {
        return Ok(HashMap::new());
    }
    serde_json::from_slice(&output.stdout).map_err(|error| {
        Failure(format!(
            "direnv printed an environment that is not JSON: {error}."
        ))
    })
}

// Copies the server's stderr to the app's stderr line by line, keeping the last lines for the
// failure report.
fn forward_stderr(child: &mut Child) -> (Arc<Mutex<VecDeque<String>>>, JoinHandle<()>) {
    let lines = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_LINES)));
    let pipe = child.stderr.take().expect("stderr is piped");
    let kept = Arc::clone(&lines);
    let reader = thread::spawn(move || {
        for line in BufReader::new(pipe).lines() {
            let line = line.expect("server stderr is UTF-8");
            writeln!(io::stderr(), "{line}").expect("the app's stderr is writable");
            // The server's tools colour their messages; the report shows plain text.
            let line = strip_ansi_escapes::strip_str(&line);
            let mut kept = kept.lock().expect("stderr buffer lock");
            if kept.len() == STDERR_LINES {
                kept.pop_front();
            }
            kept.push_back(line);
        }
    });
    (lines, reader)
}

fn describe(status: io::Result<ExitStatus>, tail: &VecDeque<String>) -> String {
    let status = match status {
        Ok(status) => status.to_string(),
        Err(error) => format!("could not be waited for: {error}"),
    };
    let tail: Vec<&str> = tail.iter().map(String::as_str).collect();
    format!("The server stopped ({status}).\n\n{}", tail.join("\n"))
}

// Polls `/status` until it answers 200, as long as the server has not stopped.
pub fn wait_until_ready(origin: &str, stopped: &AtomicBool) -> Result<(), Failure> {
    let url = format!("{origin}/status");
    for _ in 0..READY_ATTEMPTS {
        if stopped.load(Ordering::SeqCst) {
            return Err(Failure("The server stopped before it answered.".into()));
        }
        // A refused connection means the server is still starting.
        if ureq::get(&url)
            .call()
            .is_ok_and(|response| response.status() == 200)
        {
            return Ok(());
        }
        thread::sleep(READY_DELAY);
    }
    Err(Failure(format!(
        "The server did not answer {url} within {READY_ATTEMPTS} seconds."
    )))
}
