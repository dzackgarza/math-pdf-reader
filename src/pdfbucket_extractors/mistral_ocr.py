"""Mistral OCR extraction: Markdown with a `<!-- page N -->` anchor before every page.

The PDF is uploaded to Mistral's files API, OCR runs on its signed URL, and the upload is
deleted afterwards, whether OCR succeeded or failed. One OCR request takes at most 1000
pages, so longer PDFs go in chunks. Reads `MISTRAL_API_KEY` from the environment.
"""

from __future__ import annotations

import os
from pathlib import Path
from tempfile import TemporaryDirectory

from cyclopts import App
from mistralai.client import Mistral
from mistralai.client.utils import BackoffStrategy, RetryConfig

from pdfbucket_extractors.pages import page_count, page_ranges, split_pdf

MODEL = "mistral-ocr-latest"
MAX_PAGES = 1000
REQUEST_TIMEOUT_MS = 300_000
# The SDK retries 429 and 5xx responses and dropped connections with this backoff.
RETRIES = RetryConfig("backoff", BackoffStrategy(2_000, 30_000, 2.0, 180_000), retry_connection_errors=True)

app = App(help="Mistral OCR extraction plugin")


def ocr_markdown(client: Mistral, pdf: Path, first_page: int) -> str:
    """Markdown for PDF, whose first page is page FIRST_PAGE (1-based) of the whole document."""
    with pdf.open("rb") as content:
        uploaded = client.files.upload(file={"file_name": pdf.name, "content": content}, purpose="ocr")
    try:
        signed = client.files.get_signed_url(file_id=uploaded.id)
        response = client.ocr.process(model=MODEL, document={"type": "document_url", "document_url": signed.url})
    finally:
        client.files.delete(file_id=uploaded.id)
    return "\n\n".join(f"<!-- page {first_page + page.index} -->\n\n{page.markdown}" for page in response.pages)


@app.default
def extract(pdf: Path, output: Path, api_base: str) -> None:
    """OCR PDF with the Mistral API at API_BASE and write OUTPUT/extraction.md."""
    client = Mistral(api_key=os.environ["MISTRAL_API_KEY"], server_url=api_base, retry_config=RETRIES, timeout_ms=REQUEST_TIMEOUT_MS)
    with TemporaryDirectory() as scratch:
        ranges = page_ranges(page_count(pdf), MAX_PAGES)
        chunks = split_pdf(pdf, ranges, Path(scratch))
        parts = [ocr_markdown(client, chunk, start + 1) for (start, _), chunk in zip(ranges, chunks, strict=True)]
    (output / "extraction.md").write_text("\n\n".join(parts), encoding="utf-8")
