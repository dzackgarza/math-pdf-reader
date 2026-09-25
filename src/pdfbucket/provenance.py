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
from pydantic import TypeAdapter

from pdfbucket.models import ItemTitle, NonEmpty, PdfRecord, Provenance

XMP_NAMESPACE = "https://github.com/dzackgarza/math-pdf-reader/ns/provenance/1.0/"

# Document-information key for each provenance field. Every field but `source_url` is required;
# a PDF captured with no known linking page carries no `/PDFBucketSourceURL`.
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
# The publication year and the abstract a resolver gave; the abstract also goes into XMP
# dc:description, the Dublin Core field for an abstract.
YEAR_KEY = "/PDFBucketYear"
ABSTRACT_KEY = "/PDFBucketAbstract"

# `/Author` holds one text string; several names are joined with "; " (the arXiv and
# ExifTool convention), which the fallback read splits again.
AUTHOR_SEPARATOR = "; "

AUTHOR_LIST: TypeAdapter[list[NonEmpty]] = TypeAdapter(list[NonEmpty])
YEAR: TypeAdapter[int] = TypeAdapter(int)


def provenance_values(provenance: Provenance) -> dict[str, str]:
    """The provenance fields to embed, each as the exact text given; an unknown source page is left out."""
    values = {
        "pdf_url": provenance.pdf_url,
        "captured_at": provenance.captured_at,
        "original_sha256": provenance.original_sha256,
        "title_hint": provenance.title_hint,
    }
    if provenance.source_url is not None:
        values["source_url"] = provenance.source_url
    return values


def embed_provenance(pdf_bytes: bytes, provenance: Provenance) -> bytes:
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
    """A PDF that does not carry the bucket's required provenance keys."""

    def __init__(self, path: Path, missing: list[str]) -> None:
        super().__init__(f"{path.name} carries no embedded provenance for {', '.join(missing)}")


def own_metadata_title(pdf: pikepdf.Pdf, docinfo: dict[str, str]) -> str | None:
    """The title the PDF's producer wrote: `/Title`, else XMP `dc:title`; None when both are blank."""
    if docinfo.get("/Title", "").strip():
        return docinfo["/Title"].strip()
    with pdf.open_metadata(set_pikepdf_as_editor=False) as xmp:
        title = str(xmp.get("dc:title", "")).strip()
    return title or None


def read_title(pdf: pikepdf.Pdf, docinfo: dict[str, str], filename: str, title_hint: str) -> ItemTitle:
    """The recorded title; else, best first, the PDF's own metadata title, the capture's hint, the file name."""
    if TITLE_KEY in docinfo:
        return ItemTitle.model_validate({"text": docinfo[TITLE_KEY], "source": docinfo[TITLE_SOURCE_KEY]})
    own = own_metadata_title(pdf, docinfo)
    if own is not None:
        return ItemTitle(text=own, source="pdf-metadata")
    if title_hint.strip():
        return ItemTitle(text=title_hint.strip(), source="capture-hint")
    return ItemTitle(text=filename, source="filename")


def read_authors(pdf: pikepdf.Pdf, docinfo: dict[str, str]) -> list[str]:
    """The recorded authors (a JSON list of names); else the PDF's own XMP `dc:creator`, else its `/Author` split at ";"."""
    if AUTHORS_KEY in docinfo:
        return AUTHOR_LIST.validate_json(docinfo[AUTHORS_KEY])
    with pdf.open_metadata(set_pikepdf_as_editor=False) as xmp:
        creators = [str(name).strip() for name in xmp.get("dc:creator", [])]
    if any(creators):
        return [name for name in creators if name]
    return [name.strip() for name in docinfo.get("/Author", "").split(";") if name.strip()]


def read_record(path: Path) -> PdfRecord:
    """Everything the PDF at PATH says about itself; raises MissingProvenanceError without the bucket's keys."""
    with pikepdf.open(path) as pdf:
        docinfo = {str(key): str(value) for key, value in pdf.docinfo.items()}
        missing = [field for field, key in DOCINFO_KEYS.items() if field != "source_url" and key not in docinfo]
        if missing:
            raise MissingProvenanceError(path, missing)
        provenance = Provenance.model_validate({field: docinfo.get(key) for field, key in DOCINFO_KEYS.items()})
        title = read_title(pdf, docinfo, path.name, provenance.title_hint)
        authors = read_authors(pdf, docinfo)
        pages = len(pdf.pages)
    year = YEAR.validate_python(docinfo[YEAR_KEY]) if YEAR_KEY in docinfo else None
    return PdfRecord(provenance=provenance, title=title, authors=authors, year=year, abstract=docinfo.get(ABSTRACT_KEY), pages=pages)


def embed_metadata(path: Path, title: ItemTitle, authors: list[str], year: int | None, abstract: str | None) -> bytes:
    """The PDF at PATH with TITLE, AUTHORS, YEAR and ABSTRACT recorded; a year or abstract of None removes one recorded before."""
    output = BytesIO()
    with pikepdf.open(path) as pdf:
        with pdf.open_metadata() as metadata:
            metadata["dc:title"] = title.text
            metadata["dc:creator"] = authors
            metadata[f"{{{XMP_NAMESPACE}}}title"] = title.text
            metadata[f"{{{XMP_NAMESPACE}}}title-source"] = title.source
            if abstract is not None:
                metadata["dc:description"] = abstract
            elif "dc:description" in metadata:
                del metadata["dc:description"]
        pdf.docinfo["/Title"] = title.text
        pdf.docinfo["/Author"] = AUTHOR_SEPARATOR.join(authors)
        pdf.docinfo[TITLE_KEY] = title.text
        pdf.docinfo[TITLE_SOURCE_KEY] = title.source
        pdf.docinfo[AUTHORS_KEY] = json.dumps(authors, ensure_ascii=False)
        for key, value in ((YEAR_KEY, year), (ABSTRACT_KEY, abstract)):
            if value is not None:
                pdf.docinfo[key] = str(value)
            elif key in pdf.docinfo:
                del pdf.docinfo[key]
        pdf.save(output)
    return output.getvalue()


# Identifiers publishers embed: arXiv's generated PDFs carry `/arXivID` and `/DOI` in the
# document-information dictionary, and publishers following PRISM carry `prism:doi` and
# `prism:isbn` in XMP.
DOCINFO_IDENTIFIER_KEYS = ("/arXivID", "/DOI")
PRISM = "http://prismstandard.org/namespaces/basic/2.0/"
PRISM_IDENTIFIER_KEYS = (f"{{{PRISM}}}doi", f"{{{PRISM}}}isbn")


def embedded_identifiers(path: Path) -> list[str]:
    """The identifiers embedded in the PDF at PATH, document-information keys first."""
    with pikepdf.open(path) as document:
        docinfo = {str(key): str(value) for key, value in document.docinfo.items()}
        embedded = [docinfo[key] for key in DOCINFO_IDENTIFIER_KEYS if key in docinfo]
        with document.open_metadata(set_pikepdf_as_editor=False) as xmp:
            embedded.extend(str(xmp[key]) for key in PRISM_IDENTIFIER_KEYS if key in xmp)
    return [identifier.strip() for identifier in embedded]
