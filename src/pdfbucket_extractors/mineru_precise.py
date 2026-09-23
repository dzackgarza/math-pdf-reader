"""MinerU precise extraction: Markdown plus MinerU's `content_list.json` and `layout.json`.

MinerU's batch API: request an upload URL, PUT the PDF, poll the batch until it is done,
download the result zip. Longer PDFs go in chunks; the chunk results are joined with their
page indexes shifted back to the whole document. Reads `MINERU_API_TOKEN` from the
environment.
"""

from __future__ import annotations

import io
import os
import time
import zipfile
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Literal

import httpx
from cyclopts import App
from pydantic import BaseModel, ConfigDict, TypeAdapter
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from pdfbucket_extractors.pages import page_count, page_ranges, split_pdf

API_BASE = "https://mineru.net/api/v4"
MODEL_VERSION = "vlm"
# The live API refuses more than 200 pages per file ("number of pages exceeds limit (200
# pages)"), whatever the vendor CLI's help text says.
MAX_PAGES = 200
# Uploads go to presigned object-storage URLs that were measured at about 44 KB/s from this
# workstation, so upload time follows bytes, not pages: chunks also stay under this budget.
MAX_UPLOAD_BYTES = 4 * 1024 * 1024
POLL_INTERVAL_SECONDS = 5
POLL_TIMEOUT_SECONDS = 600
# MinerU error codes for a busy service, a timed-out task, or a rate limit.
RETRYABLE_CODES = frozenset({-10001, -60001, -60007, -60009, -60010, -60018, -60020, -60021, -60022})

app = App(help="MinerU precise extraction plugin")


class RetryableMinerUError(RuntimeError):
    """A failure MinerU documents as transient: busy, timed out, or rate limited."""


class MinerUError(RuntimeError):
    """A failure that repeating the request does not fix."""


class Envelope(BaseModel):
    code: int
    msg: str


class BatchCreated(BaseModel):
    batch_id: str
    file_urls: list[str]


class CreatedEnvelope(Envelope):
    data: BatchCreated


class TaskDone(BaseModel):
    state: Literal["done"]
    full_zip_url: str


class TaskFailed(BaseModel):
    state: Literal["failed"]
    err_msg: str


class TaskPending(BaseModel):
    state: Literal["waiting-file", "pending", "running", "converting"]


class BatchResults(BaseModel):
    extract_result: list[TaskDone | TaskFailed | TaskPending]


class PollEnvelope(Envelope):
    data: BatchResults


class ContentBlock(BaseModel):
    """One `content_list.json` entry; every other field passes through unchanged."""

    model_config = ConfigDict(extra="allow")

    page_idx: int


class LayoutPage(BaseModel):
    model_config = ConfigDict(extra="allow")

    page_idx: int


class Layout(BaseModel):
    model_config = ConfigDict(extra="allow")

    pdf_info: list[LayoutPage]


ContentList = TypeAdapter(list[ContentBlock])


class ChunkResult(BaseModel):
    markdown: str
    content_list: list[ContentBlock]
    layout: Layout


def pages_per_chunk(pdf_bytes: int, total_pages: int) -> int:
    """Pages per chunk within MinerU's page limit and the upload byte budget."""
    bytes_per_page = pdf_bytes / total_pages
    return max(1, min(MAX_PAGES, int(MAX_UPLOAD_BYTES // bytes_per_page)))


def checked(response: httpx.Response) -> httpx.Response:
    if response.status_code == 429 or response.status_code >= 500:
        raise RetryableMinerUError(f"HTTP {response.status_code} from {response.url.host}")
    if response.status_code >= 400:
        raise MinerUError(f"HTTP {response.status_code} from {response.url.host}: {response.text[:500]}")
    return response


def api_json(response: httpx.Response) -> bytes:
    envelope = Envelope.model_validate_json(checked(response).content)
    if envelope.code in RETRYABLE_CODES:
        raise RetryableMinerUError(f"MinerU {envelope.code}: {envelope.msg}")
    if envelope.code != 0:
        raise MinerUError(f"MinerU {envelope.code}: {envelope.msg}")
    return response.content


def await_zip_url(client: httpx.Client, batch_id: str) -> str:
    deadline = time.monotonic() + POLL_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        results = PollEnvelope.model_validate_json(api_json(client.get(f"{API_BASE}/extract-results/batch/{batch_id}")))
        task = results.data.extract_result[0]
        match task:
            case TaskDone():
                return task.full_zip_url
            case TaskFailed():
                raise MinerUError(f"MinerU task failed: {task.err_msg}")
            case TaskPending():
                time.sleep(POLL_INTERVAL_SECONDS)
    raise RetryableMinerUError(f"batch {batch_id} not done after {POLL_TIMEOUT_SECONDS}s")


def zip_member(archive: zipfile.ZipFile, suffix: str) -> bytes:
    matches = [name for name in archive.namelist() if name.endswith(suffix)]
    assert len(matches) == 1, f"MinerU result zip must hold exactly one *{suffix}: {archive.namelist()}"
    return archive.read(matches[0])


@retry(
    retry=retry_if_exception_type((RetryableMinerUError, httpx.TransportError)),
    stop=stop_after_attempt(4),
    wait=wait_exponential(multiplier=5, max=60),
    reraise=True,
)
def extract_chunk(client: httpx.Client, pdf: Path, data_id: str) -> ChunkResult:
    request = {"files": [{"name": pdf.name, "data_id": data_id}], "model_version": MODEL_VERSION}
    created = CreatedEnvelope.model_validate_json(api_json(client.post(f"{API_BASE}/file-urls/batch", json=request)))
    # The presigned upload URL carries its own credentials and must not get the API token.
    checked(httpx.put(created.data.file_urls[0], content=pdf.read_bytes(), timeout=client.timeout))
    archive_bytes = checked(httpx.get(await_zip_url(client, created.data.batch_id), timeout=client.timeout)).content
    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
        return ChunkResult(
            markdown=zip_member(archive, "full.md").decode("utf-8"),
            content_list=ContentList.validate_json(zip_member(archive, "content_list.json")),
            layout=Layout.model_validate_json(zip_member(archive, "layout.json")),
        )


def joined(chunks: list[tuple[int, int, ChunkResult]]) -> ChunkResult:
    """One result for the whole PDF from chunk results that start at the given 0-based pages."""
    return ChunkResult(
        markdown="\n\n".join(f"<!-- pages {start + 1}-{stop} -->\n\n{result.markdown}" for start, stop, result in chunks),
        content_list=[block.model_copy(update={"page_idx": block.page_idx + start}) for start, _, result in chunks for block in result.content_list],
        layout=chunks[0][2].layout.model_copy(
            update={"pdf_info": [page.model_copy(update={"page_idx": page.page_idx + start}) for start, _, result in chunks for page in result.layout.pdf_info]}
        ),
    )


@app.default
def extract(pdf: Path, output: Path) -> None:
    """Extract PDF with MinerU; write OUTPUT/extraction.md and OUTPUT/artifacts/*.json."""
    headers = {"Authorization": f"Bearer {os.environ['MINERU_API_TOKEN']}"}
    total_pages = page_count(pdf)
    ranges = page_ranges(total_pages, pages_per_chunk(pdf.stat().st_size, total_pages))
    digest = sha256(pdf.read_bytes()).hexdigest()[:16]
    with httpx.Client(headers=headers, timeout=httpx.Timeout(90, write=360)) as client, TemporaryDirectory() as scratch:
        chunks = split_pdf(pdf, ranges, Path(scratch))
        results = [
            (start, stop, extract_chunk(client, chunk, f"pdfbucket-{digest}-pages-{start + 1:04d}-{stop:04d}")) for (start, stop), chunk in zip(ranges, chunks, strict=True)
        ]
    result = joined(results)
    artifacts = output / "artifacts"
    artifacts.mkdir()
    (artifacts / "content_list.json").write_text(ContentList.dump_json(result.content_list).decode("utf-8"), encoding="utf-8")
    (artifacts / "layout.json").write_text(result.layout.model_dump_json(), encoding="utf-8")
    (output / "extraction.md").write_text(result.markdown, encoding="utf-8")
