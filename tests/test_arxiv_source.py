import gzip
import io
import subprocess
import sys
import tarfile
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from pdfbucket.models import Provenance
from pdfbucket.provenance import embed_provenance

FIXTURES = Path(__file__).resolve().parent / "fixtures"
PLUGIN = Path(sys.executable).with_name("pdfbucket-arxiv-source")

MAIN = r"""\documentclass{article}
% a comment that is noise
\newcommand{\Z}{\mathbb{Z}}
\begin{document}
\input{intro}
\include{results}
\end{document}
"""
INTRO = "\\section{Intro}\nA lattice is a free $\\Z$-module. % private remark\n"
RESULTS = "\\section{Results}\nThe rank is $n$ \\cite{conway}.\n"


def tar_of(files: dict[str, str]) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for name, text in files.items():
            data = text.encode()
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def arxiv_serving(packages: dict[str, bytes]) -> Iterator[str]:
    """A stand-in for arxiv.org's /e-print/<id>: the package bytes by id, 404 otherwise."""

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            package = packages.get(self.path.removeprefix("/e-print/"))
            self.send_response(404 if package is None else 200)
            self.send_header("Content-Length", str(len(package or b"")))
            self.end_headers()
            self.wfile.write(package or b"")

        def log_message(self, fmt: str, *args: str | int) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


@pytest.fixture
def arxiv() -> Iterator[tuple[str, dict[str, bytes]]]:
    packages: dict[str, bytes] = {}
    yield from ((origin, packages) for origin in arxiv_serving(packages))


def stored(directory: Path, pdf_url: str) -> Path:
    pdf = directory / "paper.pdf"
    embed_provenance(
        FIXTURES / "lecture-notes.pdf",
        pdf,
        Provenance(pdf_url=pdf_url, captured_at="2026-01-01T00:00:00+00:00", original_sha256="0" * 64, title_hint="Paper"),
    )
    return pdf


def extract(pdf: Path, output: Path, origin: str) -> subprocess.CompletedProcess[str]:
    output.mkdir()
    return subprocess.run([PLUGIN, pdf, output, origin], capture_output=True, text=True, check=False)


def test_a_paper_strewn_across_files_becomes_one_markdown_document(arxiv: tuple[str, dict[str, bytes]], tmp_path: Path) -> None:
    origin, packages = arxiv
    packages["2301.01234"] = tar_of({"main.tex": MAIN, "intro.tex": INTRO, "results.tex": RESULTS})
    output = tmp_path / "out"

    done = extract(stored(tmp_path, "https://arxiv.org/pdf/2301.01234v2"), output, origin)

    assert done.returncode == 0, done.stderr
    markdown = (output / "extraction.md").read_text()
    assert "# Intro" in markdown
    assert "# Results" in markdown
    assert "A lattice is a free $\\mathbb{Z}$-module." in markdown
    assert "[@conway]" in markdown
    assert "noise" not in markdown
    assert "private remark" not in markdown
    flattened = (output / "artifacts" / "source.tex").read_text()
    assert "\\input{intro}" not in flattened
    assert "A lattice is a free" in flattened


def test_a_single_gzipped_tex_file_is_a_paper(arxiv: tuple[str, dict[str, bytes]], tmp_path: Path) -> None:
    origin, packages = arxiv
    packages["math/0002066"] = gzip.compress(b"\\documentclass{article}\\begin{document}Hello $x$.\\end{document}")
    output = tmp_path / "out"

    done = extract(stored(tmp_path, "https://arxiv.org/pdf/math/0002066v1"), output, origin)

    assert done.returncode == 0, done.stderr
    assert "Hello $x$." in (output / "extraction.md").read_text()


@pytest.mark.parametrize(
    ("pdf_url", "package", "message"),
    [
        ("https://example.org/paper.pdf", b"", "is not an arXiv URL"),
        ("https://arxiv.org/pdf/2301.00001", b"%PDF-1.5 only a pdf", "only a PDF"),
        ("https://arxiv.org/pdf/2301.00002", gzip.compress(b"\\input amstex plain TeX"), "plain TeX"),
    ],
)
def test_a_paper_without_usable_latex_source_fails_loudly_and_writes_nothing(
    arxiv: tuple[str, dict[str, bytes]], tmp_path: Path, pdf_url: str, package: bytes, message: str
) -> None:
    origin, packages = arxiv
    packages[pdf_url.removeprefix("https://arxiv.org/pdf/")] = package
    output = tmp_path / "out"

    done = extract(stored(tmp_path, pdf_url), output, origin)

    assert done.returncode != 0
    assert message in done.stderr
    assert list(output.iterdir()) == []
