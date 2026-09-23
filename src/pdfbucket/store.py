"""Folder-backed store: `<root>/<key>.pdf`, provenance inside each file, no sidecar."""

from __future__ import annotations

from datetime import datetime
from hashlib import sha256
from pathlib import Path

from pathvalidate import sanitize_filename

from pdfbucket.models import CaptureProvenance, CaptureRequest, CaptureResult, provenance_for
from pdfbucket.provenance import embed_provenance, read_stored_item


class UnknownKeyError(LookupError):
    """A key that names no stored PDF."""


class ChangedPdfError(ValueError):
    """Bytes offered for a stored item that do not hash to its recorded original SHA-256."""

    def __init__(self, key: str, expected: str, observed: str) -> None:
        super().__init__(f"{key}: the bytes hash to {observed}, not the recorded original {expected}")


def key_stem(filename: str) -> str:
    """The key for an uploaded filename: the sanitized name without a `.pdf` suffix.

    Only `.pdf` is stripped: `1603.04246` (an arXiv PDF URL's last segment) keeps its dot.
    """
    name = sanitize_filename(Path(filename).name, replacement_text="-")
    stem = name[: -len(".pdf")] if name.lower().endswith(".pdf") else name
    assert stem != "", f"filename must not normalize to an empty key: {filename!r}"
    return stem


def is_plain_key(key: str) -> bool:
    return key == Path(key).name and key not in {"", ".", ".."}


def pdf_path(root: Path, key: str) -> Path:
    if not is_plain_key(key):
        raise UnknownKeyError(key)
    path = root / f"{key}.pdf"
    if not path.is_file():
        raise UnknownKeyError(key)
    return path


def stored_keys(root: Path) -> list[str]:
    """Every stored key under ROOT, in key order."""
    return sorted(path.stem for path in root.glob("*.pdf") if path.is_file())


def destination(root: Path, filename: str, original_sha256: str) -> tuple[Path, bool]:
    """The path for these bytes and whether the same bytes are already stored there.

    The filename's own key wins; a different PDF already holding it moves this one to
    `<key>--<sha256 prefix>`.
    """
    stem = key_stem(filename)
    for candidate in (root / f"{stem}.pdf", root / f"{stem}--{original_sha256[:12]}.pdf"):
        if not candidate.exists():
            return candidate, False
        if read_stored_item(candidate).provenance.original_sha256 == original_sha256:
            return candidate, True
    raise AssertionError(f"two stored PDFs share the key prefix of {original_sha256}")


def write_stored(path: Path, pdf_bytes: bytes, provenance: CaptureProvenance) -> None:
    """Write the bytes with the provenance embedded; the file appears only complete."""
    partial = path.with_suffix(".partial")
    partial.write_bytes(embed_provenance(pdf_bytes, provenance))
    partial.replace(path)


def file_sha256(path: Path) -> str:
    return sha256(path.read_bytes()).hexdigest()


def store_pdf(
    root: Path,
    pdf_bytes: bytes,
    request: CaptureRequest,
    filename: str,
    captured_at: datetime,
) -> CaptureResult:
    assert root.is_dir(), f"storage root must exist: {root}"
    assert pdf_bytes.startswith(b"%PDF-"), "captured bytes are not a PDF"

    original_sha256 = sha256(pdf_bytes).hexdigest()
    path, existing = destination(root, filename, original_sha256)
    if not existing:
        write_stored(path, pdf_bytes, provenance_for(request, captured_at, original_sha256))
    return CaptureResult(item=read_stored_item(path), stored_sha256=file_sha256(path), existing=existing)


def restore_pdf(root: Path, key: str, pdf_bytes: bytes, provenance: CaptureProvenance) -> CaptureResult:
    """Store re-downloaded bytes under KEY with the provenance recorded when they were captured.

    The bytes must be the originally captured ones: anything else is a changed PDF and is not
    stored, so a key never holds bytes its recorded hash does not describe.
    """
    assert root.is_dir(), f"storage root must exist: {root}"
    assert is_plain_key(key), f"not a store key: {key!r}"
    path = root / f"{key}.pdf"
    assert not path.exists(), f"{key} is already stored"

    observed = sha256(pdf_bytes).hexdigest()
    if observed != provenance.original_sha256:
        raise ChangedPdfError(key, provenance.original_sha256, observed)
    write_stored(path, pdf_bytes, provenance)
    return CaptureResult(item=read_stored_item(path), stored_sha256=file_sha256(path), existing=False)
