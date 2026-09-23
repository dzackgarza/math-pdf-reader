"""Provenance embedded in the PDF: XMP properties plus document-information keys.

The document-information dictionary is the read path; XMP carries the same values for
tools that only read XMP.
"""

from __future__ import annotations

from io import BytesIO
from pathlib import Path

import pikepdf

from pdfbucket.models import CaptureProvenance, StoredItem

XMP_NAMESPACE = "https://github.com/dzackgarza/math-pdf-reader/ns/provenance/1.0/"

# Document-information key for each provenance field.
DOCINFO_KEYS = {
    "pdf_url": "/PDFBucketPDFURL",
    "source_url": "/PDFBucketSourceURL",
    "captured_at": "/PDFBucketCapturedAt",
    "original_sha256": "/PDFBucketOriginalSHA256",
    "title_hint": "/PDFBucketTitleHint",
}


def provenance_values(provenance: CaptureProvenance) -> dict[str, str]:
    values = provenance.model_dump(mode="json")
    return {field: str(value) for field, value in values.items()}


def embed_provenance(pdf_bytes: bytes, provenance: CaptureProvenance) -> bytes:
    values = provenance_values(provenance)
    output = BytesIO()
    with pikepdf.open(BytesIO(pdf_bytes)) as pdf:
        with pdf.open_metadata() as metadata:
            for field, value in values.items():
                metadata[f"{{{XMP_NAMESPACE}}}{field.replace('_', '-')}"] = value
        for field, value in values.items():
            pdf.docinfo[DOCINFO_KEYS[field]] = value
        pdf.save(output)
    return output.getvalue()


class MissingProvenanceError(ValueError):
    """A PDF under the store root that does not carry the bucket's provenance keys."""

    def __init__(self, path: Path, missing: list[str]) -> None:
        super().__init__(f"{path} carries no embedded provenance for {', '.join(missing)}")


def read_stored_item(path: Path) -> StoredItem:
    with pikepdf.open(path) as pdf:
        docinfo = {str(key): str(value) for key, value in pdf.docinfo.items()}
    missing = [field for field, key in DOCINFO_KEYS.items() if key not in docinfo]
    if missing:
        raise MissingProvenanceError(path, missing)
    fields = {field: docinfo[key] for field, key in DOCINFO_KEYS.items()}
    return StoredItem(
        key=path.stem,
        provenance=CaptureProvenance.model_validate(fields),
    )
