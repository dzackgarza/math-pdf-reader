//! Rollback journal for replacing the two public parts of an extraction. Like SQLite's
//! rollback journal, its presence means the old state must be restored before opening
//! the store. Hard links in the journal retain the old files. Each public path changes in
//! one atomic step: `renameat2(RENAME_EXCHANGE)` (rename(2)) swaps a new part with the
//! old one, so a reader of the paper directory finds a complete part at every moment.
//! The displaced old parts go to the desktop trash, and a rename then retires the journal.
use std::ffi::OsStr;
use std::fs::{self, File};
use std::io;
use std::path::Path;
use std::process::Command;

use nix::fcntl::{renameat2, RenameFlags, AT_FDCWD};

use crate::layout::{self, Key};

const JOURNAL: &str = ".extraction-rollback";

fn retire(journal: &Path) -> io::Result<()> {
    let root = journal.parent().expect("journal is in the store");
    let discard = tempfile::tempdir_in(root)?;
    fs::rename(journal, discard.path().join("retired"))?;
    // The rename is the commit point. A later sync failure cannot turn an installed new
    // extraction into a failed HTTP result, since the rollback journal is already gone.
    if let Err(error) = File::open(root).and_then(|directory| directory.sync_all()) {
        eprintln!("pdf-bucket: extraction journal retired but directory sync failed: {error}");
    }
    Ok(())
}

fn restore(root: &Path, journal: &Path) -> io::Result<()> {
    // Retirement can fail on a read-only store root even when restoration inside
    // the paper and journal directories succeeds. Such a journal owns no paper files.
    if journal.join("restored").try_exists()? {
        return Ok(());
    }
    let key = Key::parse(&fs::read_to_string(journal.join("key"))?).ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidData, "invalid extraction journal key")
    })?;
    for (name, path) in [
        ("artifacts", layout::extraction_dir(root, &key)),
        ("markdown", layout::markdown_path(root, &key)),
    ] {
        let backup = journal.join(name);
        let absent = journal.join(format!("no-{name}"));
        if !backup.try_exists()? && !absent.try_exists()? {
            continue; // Already restored before an interrupted rollback.
        }
        match path.symlink_metadata() {
            Ok(_) => fs::rename(&path, journal.join(format!("discard-{name}")))?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        if !absent.try_exists()? {
            fs::rename(backup, path)?;
        }
    }
    File::open(layout::document_dir(root, &key))?.sync_all()?;
    fs::rename(journal.join("key"), journal.join("restored"))?;
    File::open(journal)?.sync_all()
}

fn rollback(root: &Path, journal: &Path) -> io::Result<()> {
    restore(root, journal)?;
    retire(journal)
}

pub fn recover(root: &Path) -> io::Result<()> {
    let directory = File::open(root)?;
    directory.lock()?;
    let journal = root.join(JOURNAL);
    if journal.try_exists()? {
        rollback(root, &journal)?;
    }
    Ok(())
}

/// Puts NEW at LIVE in one step. An old LIVE moves to DISPLACED.
fn replace(new: &Path, live: &Path, displaced: &Path) -> io::Result<()> {
    match live.symlink_metadata() {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return fs::rename(new, live),
        Err(error) => return Err(error),
    }
    renameat2(AT_FDCWD, new, AT_FDCWD, live, RenameFlags::RENAME_EXCHANGE)
        .map_err(io::Error::from)?;
    fs::rename(new, displaced)
}

fn file_name(path: &Path) -> &OsStr {
    path.file_name().expect("a store path has a file name")
}

pub fn publish(
    root: &Path,
    key: &Key,
    markdown: &Path,
    artifacts: Option<&Path>,
) -> io::Result<()> {
    let directory = File::open(root)?;
    directory.lock()?;
    let journal = root.join(JOURNAL);
    if journal.try_exists()? {
        rollback(root, &journal)?;
    }
    let staging = tempfile::tempdir_in(root)?;
    let backup = staging.path().join("previous");
    fs::create_dir(&backup)?;
    fs::write(backup.join("key"), key.as_str())?;
    File::open(backup.join("key"))?.sync_all()?;
    let markdown_path = layout::markdown_path(root, key);
    let extraction_dir = layout::extraction_dir(root, key);
    for (name, path) in [("markdown", &markdown_path), ("artifacts", &extraction_dir)] {
        if path.try_exists()? {
            let copy = Command::new("cp")
                .args(["--archive", "--link", "--"])
                .arg(path)
                .arg(backup.join(name))
                .output()?;
            if !copy.status.success() {
                return Err(io::Error::other(
                    String::from_utf8_lossy(&copy.stderr).into_owned(),
                ));
            }
        } else {
            File::create(backup.join(format!("no-{name}")))?;
        }
    }
    File::open(&backup)?.sync_all()?;
    fs::rename(&backup, &journal)?;
    directory.sync_all()?;
    let displaced = staging.path().join("displaced");
    fs::create_dir(&displaced)?;
    let displaced_markdown = displaced.join(file_name(&markdown_path));
    let displaced_artifacts = displaced.join(file_name(&extraction_dir));
    let install = || -> io::Result<()> {
        if let Some(artifacts) = artifacts {
            replace(artifacts, &extraction_dir, &displaced_artifacts)?;
        }
        #[cfg(feature = "arxiv-fixtures")]
        crate::store::test_gate("PDF_BUCKET_TEST_EXTRACTION_PUBLISH")?;
        // The Markdown changes last, since its presence marks a complete extraction.
        replace(markdown, &markdown_path, &displaced_markdown)?;
        if artifacts.is_none() && extraction_dir.try_exists()? {
            fs::rename(&extraction_dir, &displaced_artifacts)?;
        }
        File::open(layout::document_dir(root, key))?.sync_all()?;
        let old = fs::read_dir(&displaced)?
            .map(|entry| entry.map(|entry| entry.path()))
            .collect::<io::Result<Vec<_>>>()?;
        trash::delete_all(old).map_err(io::Error::other)?;
        retire(&journal)
    };
    if let Err(error) = install() {
        restore(root, &journal).map_err(|restore_error| {
            io::Error::other(format!(
                "{error}; could not restore the previous extraction: {restore_error}"
            ))
        })?;
        if let Err(cleanup) = retire(&journal) {
            return Err(io::Error::other(format!(
                "{error}; previous extraction restored; journal cleanup pending: {cleanup}"
            )));
        }
        return Err(error);
    }
    Ok(())
}
