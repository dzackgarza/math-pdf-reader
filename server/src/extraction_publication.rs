//! Rollback journal for replacing the two public parts of an extraction. Like SQLite's
//! rollback journal, its presence means the old state must be restored before opening
//! the store. Hard links retain the old files while the desktop trash records their
//! original names. A rename retires the journal only after both new paths are in place.
use std::fs::{self, File};
use std::io;
use std::path::Path;
use std::process::Command;

use crate::layout::{self, Key};

const JOURNAL: &str = ".extraction-rollback";

fn retire(journal: &Path) -> io::Result<()> {
    let root = journal.parent().expect("journal is in the store");
    let discard = tempfile::tempdir_in(root)?;
    fs::rename(journal, discard.path().join("retired"))?;
    File::open(root)?.sync_all()
}

fn rollback(root: &Path, journal: &Path) -> io::Result<()> {
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
    let mut previous = Vec::new();
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
            previous.push(path);
        } else {
            File::create(backup.join(format!("no-{name}")))?;
        }
    }
    File::open(&backup)?.sync_all()?;
    fs::rename(&backup, &journal)?;
    directory.sync_all()?;
    let install = || -> io::Result<()> {
        trash::delete_all(previous).map_err(io::Error::other)?;
        if let Some(artifacts) = artifacts {
            fs::rename(artifacts, &extraction_dir)?;
        }
        #[cfg(feature = "arxiv-fixtures")]
        crate::store::test_gate("PDF_BUCKET_TEST_EXTRACTION_PUBLISH")?;
        fs::rename(markdown, &markdown_path)?;
        File::open(layout::document_dir(root, key))?.sync_all()
    };
    if let Err(error) = install() {
        rollback(root, &journal).map_err(|restore| {
            io::Error::other(format!(
                "{error}; could not restore the previous extraction: {restore}"
            ))
        })?;
        return Err(error);
    }
    retire(&journal)
}
