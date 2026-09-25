"""The shipped resolver plugins, run as the server runs them (the identifier on stdin, in the
manifest's directory) against a replay of the upstream responses they were captured from, and
the identifiers the pikepdf command finds embedded in a publisher's PDF."""

import json
import subprocess
import sys
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import bibtexparser
import pikepdf
import pytest
from bibtexparser.middlewares import LatexDecodingMiddleware

FIXTURES = Path(__file__).resolve().parent / "fixtures"
CAPTURES = FIXTURES / "resolvers"
MANIFEST = Path(__file__).resolve().parents[1] / "plugins" / "manifests" / "resolvers.json"
ARXIV_PDF = FIXTURES / "arxiv-2609.21174v1.pdf"
LECTURE_NOTES = FIXTURES / "lecture-notes.pdf"
PDFBUCKET = Path(sys.executable).with_name("pdfbucket")


class ReplayHandler(BaseHTTPRequestHandler):
    """Answers each captured request with the response the live service gave; anything else is 404."""

    captured: dict[str, tuple[str, bytes]] = {
        entry["request"]: (entry["content_type"], (CAPTURES / entry["file"]).read_bytes()) for entry in json.loads((CAPTURES / "captures.json").read_text())["responses"]
    }

    def do_GET(self) -> None:
        if self.path not in self.captured:
            self.send_error(404)
            return
        content_type, body = self.captured[self.path]
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args: str | int) -> None:
        return


@pytest.fixture(scope="module")
def replay() -> Iterator[str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), ReplayHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


def resolve(plugin_id: str, identifier: str, upstream: str) -> subprocess.CompletedProcess[str]:
    """The shipped plugin's command with its upstream base URL pointed at UPSTREAM."""
    [plugin] = [plugin for plugin in json.loads(MANIFEST.read_text())["plugins"] if plugin["id"] == plugin_id]
    runner, script, _upstream = plugin["command"]
    return subprocess.run([runner, script, upstream], input=identifier, cwd=MANIFEST.parent, capture_output=True, text=True, check=False)


def fields(bibtex: str) -> dict[str, str]:
    library = bibtexparser.parse_string(bibtex, append_middleware=[LatexDecodingMiddleware()])
    assert len(library.entries) == 1, bibtex
    entry = library.entries[0]
    return {"ENTRYTYPE": entry.entry_type, **{field.key.lower(): field.value for field in entry.fields}}


def test_the_arxiv_resolver_gives_biblatex_eprint_fields(replay: str) -> None:
    resolved = resolve("arxiv", "https://arxiv.org/abs/2609.21174v1", replay)

    assert resolved.returncode == 0, resolved.stderr
    entry = fields(resolved.stdout)
    assert entry["title"] == "On The Cyclicity of Algebraic Lattices"
    # arXiv's natbib `archivePrefix` arrives as biblatex `eprinttype`, which Zotero's BibTeX import keeps.
    assert (entry["eprinttype"], entry["eprint"], entry["eprintclass"]) == ("arXiv", "2609.21174", "math.NT")
    assert "archiveprefix" not in entry
    # arXiv's BibTeX export has no abstract; it comes from the summary of the API's Atom entry.
    assert entry["abstract"].startswith("This work presents theoretical advances in the study of cyclic and quasi-cyclic lattices.")
    # arXiv's BibTeX export has no abstract; it comes from the summary of the API's Atom entry.
    assert entry["abstract"].startswith("This work presents theoretical advances in the study of cyclic and quasi-cyclic lattices.")


def test_the_doi_resolver_gives_the_publisher_article(replay: str) -> None:
    resolved = resolve("doi", "https://doi.org/10.4007/annals.2017.185.3.7", replay)

    assert resolved.returncode == 0, resolved.stderr
    entry = fields(resolved.stdout)
    assert (entry["ENTRYTYPE"], entry["doi"], entry["journal"]) == ("article", "10.4007/annals.2017.185.3.7", "Annals of Mathematics")


def test_the_zbmath_resolver_builds_an_article_from_the_zbmath_record(replay: str) -> None:
    resolved = resolve("zbmath", "https://zbmath.org/?q=an:0139.24606", replay)

    assert resolved.returncode == 0, resolved.stderr
    entry = fields(resolved.stdout)
    assert entry["ENTRYTYPE"] == "article"
    assert (entry["title"], entry["author"], entry["year"]) == ("Fuzzy sets", "Zadeh, L. A.", "1965")
    # Journal, volume and DOI come from the series entry and the link list of the zbMATH record.
    assert (entry["journal"], entry["volume"], entry["pages"]) == ("Information and Control", "8", "338–353")
    assert entry["doi"] == "10.1016/S0019-9958(65)90241-X"


def test_the_isbn_resolver_builds_a_book_from_the_edition_and_author_records(replay: str) -> None:
    resolved = resolve("isbn", "978-0-387-90244-9", replay)

    assert resolved.returncode == 0, resolved.stderr
    entry = fields(resolved.stdout)
    assert entry["ENTRYTYPE"] == "book"
    assert (entry["author"], entry["publisher"], entry["year"], entry["isbn"]) == ("Robin Hartshorne", "Springer", "1997", "9780387902449")


@pytest.mark.parametrize(
    ("answer", "reason"),
    [
        (
            "@article{first, title={Sphere packing}}\n@article{second, title={Sphere packing}}",
            "expected exactly one BibTeX entry, got 2",
        ),
        ("@article{viazovska, title={The sphere packing problem in dimension 8}", "BibTeX does not parse"),
        ("<html><body>Sign in to continue</body></html>", "expected exactly one BibTeX entry, got 0"),
    ],
)
def test_a_resolver_fails_when_the_upstream_answer_is_not_exactly_one_well_formed_bibtex_entry(answer: str, reason: str) -> None:
    class Answer(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            body = answer.encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/x-bibtex")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, fmt: str, *args: str | int) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Answer)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    completed = resolve("doi", "10.4007/annals.2017.185.3.7", f"http://127.0.0.1:{server.server_address[1]}")
    server.shutdown()

    assert completed.returncode == 1
    assert completed.stdout == ""
    assert completed.stderr.startswith(reason)


def test_an_upstream_refusal_is_a_non_zero_exit(replay: str) -> None:
    assert resolve("arxiv", "https://arxiv.org/abs/2609.99999", replay).returncode != 0


def identifiers(pdf: Path) -> list[str]:
    listed = subprocess.run([PDFBUCKET, "identifiers", "--", pdf], capture_output=True, text=True, check=True)
    found: list[str] = json.loads(listed.stdout)
    return found


def test_the_identifiers_a_publisher_embeds_are_read_from_the_pdf(tmp_path: Path) -> None:
    # A publisher's book PDF: its XMP names the ISBN under PRISM.
    book = tmp_path / "hartshorne.pdf"
    with pikepdf.open(LECTURE_NOTES) as pdf:
        with pdf.open_metadata() as xmp:
            xmp["{http://prismstandard.org/namespaces/basic/2.0/}isbn"] = "978-0-387-90244-9"
        pdf.save(book)

    assert identifiers(ARXIV_PDF) == ["https://arxiv.org/abs/2609.21174v1", "https://doi.org/10.48550/arXiv.2609.21174"]
    assert identifiers(book) == ["978-0-387-90244-9"]
    assert identifiers(LECTURE_NOTES) == []
