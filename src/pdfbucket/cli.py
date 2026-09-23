"""Command line the server calls: `pdfbucket <command>`, JSON on stdout."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from cyclopts import App
from pydantic import HttpUrl, TypeAdapter

from pdfbucket.models import CaptureRequest, StoredItem
from pdfbucket.provenance import read_stored_item
from pdfbucket.store import pdf_path, store_pdf, stored_keys

app = App(help="PDF Bucket store")


@app.command
def capture(root: Path, pdf: Path, filename: str, pdf_url: str, source_url: str, title_hint: str) -> None:
    """Store the PDF at PDF under ROOT with its provenance embedded; print the result."""
    request = CaptureRequest(pdf_url=HttpUrl(pdf_url), source_url=HttpUrl(source_url), title_hint=title_hint)
    result = store_pdf(root, pdf.read_bytes(), request, filename, datetime.now(UTC))
    print(result.model_dump_json())


@app.command
def describe(root: Path, key: str) -> None:
    """Print the stored item for KEY, read from the PDF alone."""
    print(read_stored_item(pdf_path(root, key)).model_dump_json())


@app.command(name="list")
def list_items(root: Path, *keys: str) -> None:
    """Print the stored items for KEYS, or for every PDF under ROOT, read from the PDFs alone."""
    items = [read_stored_item(pdf_path(root, key)) for key in keys or stored_keys(root)]
    print(TypeAdapter(list[StoredItem]).dump_json(items).decode())
