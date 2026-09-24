"""Provenance, title and authors embedded in the PDF: XMP properties plus document-information keys.

The document-information dictionary is the read path; XMP carries the same values for
tools that only read XMP. A title and authors the bucket settles on (from an identifier
resolver) go into the standard `/Title`, `/Author`, `dc:title` and `dc:creator`, so every PDF
tool shows them, with the title's source beside it in the bucket's own keys; until then both
are read from what the file already holds.
"""

from __future__ import annotations

import json
from io import BytesIO
from pathlib import Path

import pikepdf

from pdfbucket.models import CaptureProvenance, ItemTitle, StoredItem

XMP_NAMESPACE = "https://github.com/dzackgarza/math-pdf-reader/ns/provenance/1.0/"

# Document-information key for each provenance field.
DOCINFO_KEYS = {
    "pdf_url": "/PDFBucketPDFURL",
    "source_url": "/PDFBucketSourceURL",
    "captured_at": "/PDFBucketCapturedAt",
    "original_sha256": "/PDFBucketOriginalSHA256",
    "title_hint": "/PDFBucketTitleHint",
}


# The title the bucket recorded and where it came from, and the authors it recorded (a JSON list).
TITLE_KEY = "/PDFBucketTitle"
TITLE_SOURCE_KEY = "/PDFBucketTitleSource"
AUTHORS_KEY = "/PDFBucketAuthors"

# `/Author` holds one text string; several names are joined with "; " (the arXiv and
# ExifTool convention), which the fallback read splits again.
AUTHOR_SEPARATOR = "; "


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


def own_metadata_title(pdf: pikepdf.Pdf, docinfo: dict[str, str]) -> str | None:
    """The title the PDF's producer wrote: `/Title`, else XMP `dc:title`; None when both are blank."""
    if docinfo.get("/Title", "").strip():
        return docinfo["/Title"].strip()
    with pdf.open_metadata(set_pikepdf_as_editor=False) as xmp:
        title = str(xmp.get("dc:title", "")).strip()
    return title or None


def read_title(pdf: pikepdf.Pdf, docinfo: dict[str, str], key: str, title_hint: str) -> ItemTitle:
    """The recorded title; else, best first, the PDF's own metadata title, the capture's hint, the filename."""
    if TITLE_KEY in docinfo:
        return ItemTitle.model_validate({"text": docinfo[TITLE_KEY], "source": docinfo[TITLE_SOURCE_KEY]})
    own = own_metadata_title(pdf, docinfo)
    if own is not None:
        return ItemTitle(text=own, source="pdf-metadata")
    if title_hint.strip():
        return ItemTitle(text=title_hint.strip(), source="capture-hint")
    return ItemTitle(text=f"{key}.pdf", source="filename")


def read_authors(pdf: pikepdf.Pdf, docinfo: dict[str, str]) -> list[str]:
    """The recorded authors; else the PDF's own XMP `dc:creator`, else its `/Author` split at ";"."""
    if AUTHORS_KEY in docinfo:
        return [str(name) for name in json.loads(docinfo[AUTHORS_KEY])]
    with pdf.open_metadata(set_pikepdf_as_editor=False) as xmp:
        creators = [str(name).strip() for name in xmp.get("dc:creator", [])]
    if any(creators):
        return [name for name in creators if name]
    return [name.strip() for name in docinfo.get("/Author", "").split(";") if name.strip()]


def read_stored_item(path: Path) -> StoredItem:
    with pikepdf.open(path) as pdf:
        docinfo = {str(key): str(value) for key, value in pdf.docinfo.items()}
        missing = [field for field, key in DOCINFO_KEYS.items() if key not in docinfo]
        if missing:
            raise MissingProvenanceError(path, missing)
        provenance = CaptureProvenance.model_validate({field: docinfo[key] for field, key in DOCINFO_KEYS.items()})
        title = read_title(pdf, docinfo, path.stem, provenance.title_hint)
        authors = read_authors(pdf, docinfo)
    return StoredItem(key=path.stem, provenance=provenance, title=title, authors=authors)


def embed_metadata(path: Path, title: ItemTitle, authors: list[str]) -> None:
    """Record TITLE and AUTHORS in the stored PDF at PATH; the file is replaced only complete."""
    partial = path.with_suffix(".partial")
    with pikepdf.open(path) as pdf:
        with pdf.open_metadata() as metadata:
            metadata["dc:title"] = title.text
            metadata["dc:creator"] = authors
            metadata[f"{{{XMP_NAMESPACE}}}title"] = title.text
            metadata[f"{{{XMP_NAMESPACE}}}title-source"] = title.source
        pdf.docinfo["/Title"] = title.text
        pdf.docinfo["/Author"] = AUTHOR_SEPARATOR.join(authors)
        pdf.docinfo[TITLE_KEY] = title.text
        pdf.docinfo[TITLE_SOURCE_KEY] = title.source
        pdf.docinfo[AUTHORS_KEY] = json.dumps(authors, ensure_ascii=False)
        pdf.save(partial)
    partial.replace(path)
