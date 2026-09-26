"""Command line the server calls: `pdfbucket <command>`, the pikepdf and MuPDF work on one PDF.

The server owns the store's layout and every write: these commands read the files or bytes it
names and print what they make on stdout (a PDF, a PNG, or one JSON document). A command that
cannot read its PDF prints a StoreFailure document and exits with status 3.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pikepdf
from cyclopts import App
from pydantic import TypeAdapter, ValidationError

from pdfbucket.metadata_guess import (
    GuessResult,
    MetadataInferenceError,
    MetadataPacket,
    guess_metadata,
)
from pdfbucket.models import (
    ItemTitle,
    NonEmpty,
    Provenance,
    Read,
    ReadOutcome,
    StoreFailure,
    TitleSource,
    Unreadable,
)
from pdfbucket.provenance import (
    MissingProvenanceError,
    embed_metadata,
    embed_provenance,
    embedded_identifiers,
    read_record,
)
from pdfbucket.thumbnails import render_first_page

app = App(help="PDF Bucket's pikepdf and MuPDF commands")

READ_OUTCOMES: TypeAdapter[list[ReadOutcome]] = TypeAdapter(list[ReadOutcome])
IDENTIFIERS: TypeAdapter[list[NonEmpty]] = TypeAdapter(list[NonEmpty])

# Exit status of a command whose PDF could not be read; stdout then holds a StoreFailure.
FAILED = 3


def write_bytes(data: bytes) -> None:
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


@app.command(name="embed-provenance")
def embed_provenance_command(
    *,
    pdf_url: str,
    captured_at: str,
    original_sha256: str,
    title_hint: str,
    source_url: str | None = None,
) -> None:
    """Print the PDF read from stdin with the provenance embedded."""
    provenance = Provenance(
        pdf_url=pdf_url,
        source_url=source_url,
        captured_at=captured_at,
        original_sha256=original_sha256,
        title_hint=title_hint,
    )
    write_bytes(embed_provenance(sys.stdin.buffer.read(), provenance))


@app.command(name="embed-metadata")
def embed_metadata_command(
    pdf: Path,
    text: str,
    source: TitleSource,
    *,
    author: tuple[str, ...] = (),
    year: int | None = None,
    abstract: str | None = None,
) -> None:
    """Print PDF with TEXT, from SOURCE, as its title, each AUTHOR in order, YEAR and ABSTRACT recorded."""
    write_bytes(embed_metadata(pdf, ItemTitle(text=text, source=source), list(author), year, abstract))


def read_one(path: Path) -> ReadOutcome:
    # A torn or foreign file is one file's outcome, not a failure of the whole read.
    try:
        return Read(record=read_record(path))
    except (pikepdf.PdfError, MissingProvenanceError, ValidationError) as error:
        return Unreadable(message=str(error))


@app.command
def read(*paths: Path) -> None:
    """Print, for each PATH in order, what the PDF says about itself or why it cannot be read."""
    print(READ_OUTCOMES.dump_json([read_one(path) for path in paths]).decode())


@app.command
def identifiers(pdf: Path) -> None:
    """Print the identifiers the publisher embedded in PDF, as a JSON list."""
    print(IDENTIFIERS.dump_json(embedded_identifiers(pdf)).decode())


@app.command
def thumbnail(pdf: Path, width: int) -> None:
    """Print PDF's first page, WIDTH pixels wide, as a PNG."""
    write_bytes(render_first_page(pdf, width))


@app.command(name="guess-metadata")
def guess_metadata_command(
    pdf: Path,
    *,
    pdf_url: str,
    title_hint: str,
    source_url: str | None = None,
) -> None:
    """Infer title, authors, and year from a PDF and its capture context."""
    packet = MetadataPacket.from_pdf(
        pdf,
        pdf_url=pdf_url,
        source_url=source_url,
        title_hint=title_hint,
    )
    result: GuessResult = guess_metadata(packet)
    print(result.model_dump_json())


def main() -> None:
    """Run one command; a PDF it cannot read becomes a StoreFailure the server tells apart."""
    try:
        app()
    except pikepdf.PdfError as error:
        failure = StoreFailure(kind="unreadable_pdf", message=str(error))
    except MissingProvenanceError as error:
        failure = StoreFailure(kind="missing_provenance", message=str(error))
    except ValidationError as error:
        failure = StoreFailure(kind="invalid_metadata", message=str(error))
    except MetadataInferenceError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    else:
        return
    print(failure.model_dump_json())
    sys.exit(FAILED)
