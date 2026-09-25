"""MinerU precise extraction: Markdown plus MinerU's `content_list.json` and `layout.json`.

MinerU's batch API: request an upload URL, PUT the PDF, poll the batch until it is done,
download the result zip. Longer PDFs go in chunks; the chunk results are joined with their
page indexes shifted back to the whole document. Reads `MINERU_API_TOKEN` from the
environment; the API base URL is the third argument.

A submitted batch is a paid job, so a submission is never repeated: only the idempotent
calls (the upload PUT, each poll, the result download) are retried. Each chunk's batch id
and result zip are kept under the user cache directory, per PDF digest, as soon as MinerU
answers. A failed chunk does not stop the others; the run then fails naming every failed
chunk, and a rerun on the same PDF reuses the finished chunks, resumes polling the batches
already submitted, and submits only the chunks that have no batch. The cache for a PDF is
removed once its extraction is written.
"""

from __future__ import annotations

import io
import os
import shutil
import time
import zipfile
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Literal

import httpx
from cyclopts import App
from platformdirs import user_cache_path
from pydantic import BaseModel, ConfigDict, TypeAdapter
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from pdfbucket_extractors.pages import page_count, page_ranges, split_pdf

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


class TaskFailedError(MinerUError):
    """MinerU finished a batch as failed; only a new submission can extract that chunk."""


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


# Only calls that repeat without effect are retried: a repeated submission is a new paid job.
idempotent = retry(
    retry=retry_if_exception_type((RetryableMinerUError, httpx.TransportError)),
    stop=stop_after_attempt(4),
    wait=wait_exponential(multiplier=5, max=60),
    reraise=True,
)


@idempotent
def storage_request(storage: httpx.Client, method: Literal["GET", "PUT"], url: str, content: bytes | None = None) -> httpx.Response:
    """A request to a presigned object-storage URL, which carries its own credentials."""
    return checked(storage.request(method, url, content=content))


@idempotent
def poll(api: httpx.Client, api_base: str, batch_id: str) -> TaskDone | TaskFailed | TaskPending:
    return PollEnvelope.model_validate_json(api_json(api.get(f"{api_base}/extract-results/batch/{batch_id}"))).data.extract_result[0]


def await_zip_url(api: httpx.Client, api_base: str, batch_id: str) -> str:
    deadline = time.monotonic() + POLL_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        task = poll(api, api_base, batch_id)
        match task:
            case TaskDone():
                return task.full_zip_url
            case TaskFailed():
                raise TaskFailedError(f"MinerU task failed: {task.err_msg}")
            case TaskPending():
                time.sleep(POLL_INTERVAL_SECONDS)
    raise MinerUError(f"batch {batch_id} not done after {POLL_TIMEOUT_SECONDS}s; a rerun resumes polling it")


def zip_member(archive: zipfile.ZipFile, suffix: str) -> bytes:
    matches = [name for name in archive.namelist() if name.endswith(suffix)]
    assert len(matches) == 1, f"MinerU result zip must hold exactly one *{suffix}: {archive.namelist()}"
    return archive.read(matches[0])


def chunk_result(archive_bytes: bytes) -> ChunkResult:
    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
        return ChunkResult(
            markdown=zip_member(archive, "full.md").decode("utf-8"),
            content_list=ContentList.validate_json(zip_member(archive, "content_list.json")),
            layout=Layout.model_validate_json(zip_member(archive, "layout.json")),
        )


def submit(api: httpx.Client, storage: httpx.Client, api_base: str, pdf: Path, data_id: str) -> str:
    """Create a batch for PDF, upload PDF to it, and return its id. Each call is a new paid job."""
    request = {"files": [{"name": pdf.name, "data_id": data_id}], "model_version": MODEL_VERSION}
    created = CreatedEnvelope.model_validate_json(api_json(api.post(f"{api_base}/file-urls/batch", json=request)))
    storage_request(storage, "PUT", created.data.file_urls[0], pdf.read_bytes())
    return created.data.batch_id


def extract_chunk(api: httpx.Client, storage: httpx.Client, api_base: str, pdf: Path, data_id: str, state: Path) -> ChunkResult:
    """The chunk's result from the zip kept in STATE, else from its recorded batch, else from a new batch.

    The batch id is recorded once the upload has landed, so a batch that never got its file is
    not resumed; a batch MinerU failed is forgotten, so a rerun submits the chunk again.
    """
    archive = state / "result.zip"
    if archive.exists():
        return chunk_result(archive.read_bytes())
    batch = state / "batch_id"
    if not batch.exists():
        state.mkdir(parents=True, exist_ok=True)
        batch.write_text(submit(api, storage, api_base, pdf, data_id), encoding="utf-8")
    try:
        zip_url = await_zip_url(api, api_base, batch.read_text(encoding="utf-8"))
    except TaskFailedError:
        batch.unlink()
        raise
    archive_bytes = storage_request(storage, "GET", zip_url).content
    result = chunk_result(archive_bytes)
    partial = state / "result.zip.partial"
    partial.write_bytes(archive_bytes)
    partial.replace(archive)
    return result


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
def extract(pdf: Path, output: Path, api_base: str) -> None:
    """Extract PDF with the MinerU API at API_BASE; write OUTPUT/extraction.md and OUTPUT/artifacts/*.json."""
    headers = {"Authorization": f"Bearer {os.environ['MINERU_API_TOKEN']}"}
    total_pages = page_count(pdf)
    ranges = page_ranges(total_pages, pages_per_chunk(pdf.stat().st_size, total_pages))
    digest = sha256(pdf.read_bytes()).hexdigest()
    state = user_cache_path("pdfbucket") / "mineru-precise" / f"{MODEL_VERSION}-{digest}"
    timeout = httpx.Timeout(90, write=360)
    results: list[tuple[int, int, ChunkResult]] = []
    failures: list[str] = []
    # The presigned storage URLs carry their own credentials and must not get the API token.
    with httpx.Client(headers=headers, timeout=timeout) as api, httpx.Client(timeout=timeout) as storage, TemporaryDirectory() as scratch:
        chunks = split_pdf(pdf, ranges, Path(scratch))
        for (start, stop), chunk in zip(ranges, chunks, strict=True):
            pages = f"pages-{start + 1:04d}-{stop:04d}"
            try:
                results.append((start, stop, extract_chunk(api, storage, api_base, chunk, f"pdfbucket-{digest[:16]}-{pages}", state / pages)))
            except (MinerUError, RetryableMinerUError, httpx.HTTPError) as error:
                failures.append(f"pages {start + 1}-{stop}: {error}")
    if failures:
        raise MinerUError(f"{len(failures)} of {len(ranges)} chunks failed; the finished chunks are kept in {state} and a rerun extracts only the rest\n" + "\n".join(failures))
    result = joined(results)
    artifacts = output / "artifacts"
    artifacts.mkdir()
    (artifacts / "content_list.json").write_text(ContentList.dump_json(result.content_list).decode("utf-8"), encoding="utf-8")
    (artifacts / "layout.json").write_text(result.layout.model_dump_json(), encoding="utf-8")
    (output / "extraction.md").write_text(result.markdown, encoding="utf-8")
    shutil.rmtree(state)
