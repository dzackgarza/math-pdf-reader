//! The store's file layout, owned here alone: `<root>/<key>.pdf` holds a stored PDF with its
//! provenance inside, `<key>.md` and `<key>.extraction/` beside it hold its extraction, and a
//! name starting with `.` is a write in progress (a temporary file or staging directory). Keys
//! are derived from a PDF's file name and validated in one place, `Key::parse`.
use std::path::{Path, PathBuf};

use crate::config::{EXTRACTION_SUFFIX, KEY_HASH_PREFIX, MAX_KEY_BYTES, PDF_HEADER_WINDOW};
use sanitize_filename::{
    is_sanitized_with_options, sanitize_with_options, Options, OptionsForCheck,
};

/// Whether BYTES are a PDF: `%PDF-` starts within the first 1024 bytes.
pub fn is_pdf(bytes: &[u8]) -> bool {
    let window = &bytes[..bytes.len().min(PDF_HEADER_WINDOW + b"%PDF-".len() - 1)];
    window
        .windows(b"%PDF-".len())
        .any(|start| start == b"%PDF-")
}

fn unix_names() -> Options<'static> {
    Options {
        windows: false,
        truncate: false,
        replacement: "-",
    }
}

/// A store key: a file name stem that is not hidden, holds no path separator, control
/// character or character sanitize-filename replaces, and leaves every file named after it
/// within NAME_MAX.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Key(String);

impl Key {
    pub fn parse(text: &str) -> Option<Self> {
        let sanitized = is_sanitized_with_options(
            text,
            OptionsForCheck {
                windows: false,
                truncate: true,
            },
        );
        let valid =
            sanitized && !text.is_empty() && !text.starts_with('.') && text.len() <= MAX_KEY_BYTES;
        valid.then(|| Self(text.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for Key {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

// The longest prefix of TEXT that fits BYTES and ends on a character boundary.
fn truncated(text: &str, bytes: usize) -> &str {
    let mut end = text.len().min(bytes);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// The key a file name gives: its last path component, sanitized, without a `.pdf` suffix
/// (only `.pdf`: `1603.04246`, an arXiv PDF URL's last segment, keeps its dot) and without
/// leading dots, cut to leave room for the hash suffix. None when nothing usable is left.
fn filename_key(filename: &str) -> Option<Key> {
    let name = Path::new(filename).file_name()?.to_str()?;
    let sanitized = sanitize_with_options(name, unix_names());
    let stem = match sanitized.len().checked_sub(".pdf".len()) {
        Some(at)
            if sanitized.is_char_boundary(at) && sanitized[at..].eq_ignore_ascii_case(".pdf") =>
        {
            &sanitized[..at]
        }
        _ => sanitized.as_str(),
    };
    let visible = stem.trim_start_matches('.');
    // Room for the `--<sha256 prefix>` suffix of the second candidate key.
    Key::parse(truncated(
        visible,
        MAX_KEY_BYTES - "--".len() - KEY_HASH_PREFIX,
    ))
}

/// The keys a new PDF may take, in order: the file name's own key, else the original SHA-256
/// prefix when the name gives none; then that key with `--<sha256 prefix>` appended, for a
/// different PDF offered under a name already taken.
pub fn candidate_keys(filename: Option<&str>, original_sha256: &str) -> [Key; 2] {
    let prefix = &original_sha256[..KEY_HASH_PREFIX];
    let own = match filename.and_then(filename_key) {
        Some(key) => key,
        None => Key::parse(prefix).expect("a hex prefix is a key"),
    };
    let suffixed = Key::parse(&format!("{own}--{prefix}"))
        .expect("the file name key leaves room for the hash");
    [own, suffixed]
}

pub fn pdf_path(root: &Path, key: &Key) -> PathBuf {
    root.join(format!("{key}.pdf"))
}

pub fn markdown_path(root: &Path, key: &Key) -> PathBuf {
    root.join(format!("{key}.md"))
}

pub fn extraction_dir(root: &Path, key: &Key) -> PathBuf {
    root.join(format!("{key}{EXTRACTION_SUFFIX}"))
}

/// The key of a stored PDF's file name, or None for a name that is no `<key>.pdf`.
pub fn pdf_key(file_name: &str) -> Option<Key> {
    file_name.strip_suffix(".pdf").and_then(Key::parse)
}

#[cfg(test)]
mod tests {
    use super::{candidate_keys, is_pdf, Key};
    use crate::config::MAX_KEY_BYTES;

    // The SHA-256 of tests/fixtures/lecture-notes.pdf.
    fn sha() -> &'static str {
        "5e340929db3bf5002c7a87ad166fbb4e9673bf99e8a61f6f3a92f4904e043a25"
    }

    fn first(filename: &str) -> String {
        candidate_keys(Some(filename), sha())[0].to_string()
    }

    #[test]
    fn a_key_is_the_sanitized_file_name_without_its_pdf_suffix() {
        assert_eq!(first("2401.00001"), "2401.00001");
        assert_eq!(first("2401.00001v2.pdf"), "2401.00001v2");
        assert_eq!(first("Lecture 3.PDF"), "Lecture 3");
        assert_eq!(first("ch?1:intro.pdf"), "ch-1-intro");
        assert_eq!(first("../../etc/passwd.pdf"), "passwd");
        assert_eq!(
            candidate_keys(Some("notes.pdf"), sha())[1].to_string(),
            "notes--5e340929db3b"
        );
    }

    #[test]
    fn a_name_without_a_usable_stem_takes_the_hash_prefix() {
        for name in ["..pdf", ".pdf", "..", ""] {
            assert_eq!(first(name), "5e340929db3b", "{name:?}");
        }
        assert_eq!(candidate_keys(None, sha())[0].to_string(), "5e340929db3b");
    }

    #[test]
    fn a_long_non_ascii_name_is_cut_on_a_character_boundary_and_every_file_fits_name_max() {
        let name = format!("{}.pdf", "é".repeat(200));
        for key in candidate_keys(Some(&name), sha()) {
            assert!(key.as_str().len() <= MAX_KEY_BYTES, "{key}");
            assert!(format!("{key}.extraction").len() <= 255);
        }
    }

    #[test]
    fn keys_that_name_other_files_are_refused() {
        for text in [
            "",
            ".",
            "..",
            ".hidden",
            "a/b",
            "a\u{0}b",
            &"x".repeat(MAX_KEY_BYTES + 1),
        ] {
            assert_eq!(Key::parse(text), None, "{text:?}");
        }
    }

    #[test]
    fn the_pdf_header_may_start_anywhere_in_the_first_1024_bytes() {
        let mut late = vec![b' '; 1023];
        late.extend_from_slice(b"%PDF-1.7");
        assert!(is_pdf(&late));
        let mut too_late = vec![b' '; 1024];
        too_late.extend_from_slice(b"%PDF-1.7");
        assert!(!is_pdf(&too_late));
        assert!(!is_pdf(b"<html>"));
    }
}
