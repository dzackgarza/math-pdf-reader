import json
import os
import subprocess
import sys
import threading
from collections.abc import Iterator
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

FIXTURES = Path(__file__).resolve().parent / "fixtures"
PLUGIN = Path(sys.executable).with_name("pdfbucket-mistral-ocr")


@dataclass
class MistralFiles:
    """A stand-in for Mistral's files and OCR API whose OCR refuses every document, recording what the plugin asks of it."""

    origin: str = ""
    uploaded: list[str] = field(default_factory=list)
    ocr_requests: int = 0
    deleted: list[str] = field(default_factory=list)


def handler(mistral: MistralFiles) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def answer(self, status: int, body: dict[str, str | int | bool | list[dict[str, str]]]) -> None:
            encoded = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def do_POST(self) -> None:
            assert self.headers["Authorization"] == "Bearer test-key"
            body = self.rfile.read(int(self.headers["Content-Length"]))
            if self.path == "/v1/files":
                assert b"%PDF-" in body
                file_id = f"file-{len(mistral.uploaded)}"
                mistral.uploaded.append(file_id)
                self.answer(
                    200,
                    {
                        "id": file_id,
                        "object": "file",
                        "bytes": len(body),
                        "created_at": 0,
                        "filename": "pages-0001-0010.pdf",
                        "purpose": "ocr",
                        "sample_type": "pretrain",
                        "source": "upload",
                    },
                )
                return
            assert self.path == "/v1/ocr"
            mistral.ocr_requests += 1
            self.answer(400, {"detail": [{"msg": "document could not be processed"}]})

        def do_GET(self) -> None:
            file_id = self.path.removeprefix("/v1/files/").split("/url")[0]
            assert file_id in mistral.uploaded
            self.answer(200, {"url": f"{mistral.origin}/signed/{file_id}"})

        def do_DELETE(self) -> None:
            file_id = self.path.removeprefix("/v1/files/")
            mistral.deleted.append(file_id)
            self.answer(200, {"id": file_id, "object": "file", "deleted": True})

        def log_message(self, fmt: str, *args: str | int) -> None:
            return

    return Handler


@pytest.fixture
def mistral() -> Iterator[MistralFiles]:
    fake = MistralFiles()
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler(fake))
    fake.origin = f"http://127.0.0.1:{server.server_address[1]}"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield fake
    server.shutdown()


def test_a_failed_ocr_deletes_the_upload_and_writes_no_markdown(mistral: MistralFiles, tmp_path: Path) -> None:
    completed = subprocess.run(
        [PLUGIN, FIXTURES / "ten-page-notes.pdf", tmp_path, mistral.origin],
        env={**os.environ, "MISTRAL_API_KEY": "test-key"},
        capture_output=True,
        text=True,
        check=False,
    )

    assert completed.returncode != 0
    assert mistral.ocr_requests == 1
    assert mistral.deleted == mistral.uploaded == ["file-0"]
    assert list(tmp_path.iterdir()) == []
