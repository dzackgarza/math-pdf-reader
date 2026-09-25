import io
import json
import os
import subprocess
import sys
import threading
import zipfile
from collections import Counter
from collections.abc import Iterator
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

FIXTURES = Path(__file__).resolve().parent / "fixtures"
MINERU = FIXTURES / "mineru-ten-page-notes"
# 210 text pages: two chunks under MinerU's 200-page limit, pages 1-200 and 201-210.
LONG_NOTES = FIXTURES / "long-notes.pdf"
PLUGIN = Path(sys.executable).with_name("pdfbucket-mineru-precise")


def result_zip() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name in ("full.md", "content_list.json", "layout.json"):
            archive.write(MINERU / name, f"result/{name}")
    return buffer.getvalue()


@dataclass
class MinerU:
    """A stand-in for MinerU's batch API that records what the plugin asks of it."""

    origin: str = ""
    # Pages of a chunk (the end of its data_id) whose first batch MinerU finishes as failed.
    fail_first_batch_of: set[str] = field(default_factory=set)
    # Answer each batch's first poll with HTTP 503, a transient refusal.
    busy_first_poll: bool = False
    submissions: list[str] = field(default_factory=list)
    uploads: set[str] = field(default_factory=set)
    polls: Counter[str] = field(default_factory=Counter)

    def batch_state(self, batch: str) -> dict[str, str]:
        data_id = self.submissions[int(batch.removeprefix("batch-"))]
        pages = data_id.split("-pages-")[1]
        if pages in self.fail_first_batch_of and self.submissions.count(data_id) == 1:
            return {"state": "failed", "err_msg": "file parsing failed"}
        assert batch in self.uploads, f"{batch} polled before its upload"
        return {"state": "done", "full_zip_url": f"{self.origin}/zip/{batch}"}


def handler(mineru: MinerU) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def answer(self, status: int, body: bytes, content_type: str = "application/json") -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def envelope(self, data: dict[str, str | list[str] | list[dict[str, str]]]) -> None:
            self.answer(200, json.dumps({"code": 0, "msg": "ok", "data": data}).encode())

        def do_POST(self) -> None:
            assert self.path == "/api/v4/file-urls/batch"
            assert self.headers["Authorization"] == "Bearer test-token"
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            batch = f"batch-{len(mineru.submissions)}"
            mineru.submissions.append(request["files"][0]["data_id"])
            self.envelope({"batch_id": batch, "file_urls": [f"{mineru.origin}/upload/{batch}"]})

        def do_PUT(self) -> None:
            assert "Authorization" not in self.headers
            body = self.rfile.read(int(self.headers["Content-Length"]))
            assert body.startswith(b"%PDF-")
            mineru.uploads.add(self.path.removeprefix("/upload/"))
            self.answer(200, b"", "text/plain")

        def do_GET(self) -> None:
            if self.path.startswith("/zip/"):
                self.answer(200, result_zip(), "application/zip")
                return
            batch = self.path.removeprefix("/api/v4/extract-results/batch/")
            mineru.polls[batch] += 1
            if mineru.busy_first_poll and mineru.polls[batch] == 1:
                self.answer(503, b"busy", "text/plain")
                return
            self.envelope({"batch_id": batch, "extract_result": [mineru.batch_state(batch)]})

        def log_message(self, fmt: str, *args: str | int) -> None:
            return

    return Handler


@pytest.fixture
def mineru() -> Iterator[MinerU]:
    fake = MinerU()
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler(fake))
    fake.origin = f"http://127.0.0.1:{server.server_address[1]}"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield fake
    server.shutdown()


def run_plugin(mineru: MinerU, output: Path, cache: Path) -> subprocess.CompletedProcess[str]:
    output.mkdir()
    return subprocess.run(
        [PLUGIN, LONG_NOTES, output, f"{mineru.origin}/api/v4"],
        env={**os.environ, "MINERU_API_TOKEN": "test-token", "XDG_CACHE_HOME": str(cache)},
        capture_output=True,
        text=True,
        check=False,
    )


def test_a_failed_chunk_keeps_the_finished_chunk_and_a_rerun_submits_only_the_failed_one(mineru: MinerU, tmp_path: Path) -> None:
    mineru.fail_first_batch_of = {"0201-0210"}
    cache = tmp_path / "cache"

    first = run_plugin(mineru, tmp_path / "first", cache)

    assert first.returncode != 0
    assert "1 of 2 chunks failed" in first.stderr
    assert "pages 201-210: MinerU task failed: file parsing failed" in first.stderr
    assert list((tmp_path / "first").iterdir()) == []

    second = run_plugin(mineru, tmp_path / "second", cache)

    assert second.returncode == 0, second.stderr
    assert [data_id.split("-pages-")[1] for data_id in mineru.submissions] == ["0001-0200", "0201-0210", "0201-0210"]
    markdown = (tmp_path / "second" / "extraction.md").read_text()
    assert markdown.startswith("<!-- pages 1-200 -->")
    assert "<!-- pages 201-210 -->" in markdown
    assert list((cache / "pdfbucket" / "mineru-precise").iterdir()) == []


def test_a_transient_poll_failure_resumes_polling_the_submitted_batch(mineru: MinerU, tmp_path: Path) -> None:
    mineru.busy_first_poll = True

    completed = run_plugin(mineru, tmp_path / "output", tmp_path / "cache")

    assert completed.returncode == 0, completed.stderr
    assert len(mineru.submissions) == 2
    assert mineru.polls == {"batch-0": 2, "batch-1": 2}
    assert (tmp_path / "output" / "artifacts" / "layout.json").is_file()
