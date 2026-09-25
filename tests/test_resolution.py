import json
import os
import subprocess
import sys
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import bibtexparser
from bibtexparser.middlewares import LatexDecodingMiddleware
import pikepdf
import pytest
from pydantic import TypeAdapter

from pdfbucket.cli import app
from pdfbucket.manifest import PluginManifest, load_manifest
from pdfbucket.models import StoredItem
from pdfbucket.resolution import Resolved, ResolverFailed, Unidentified

FIXTURES = Path(__file__).resolve().parent / "fixtures"
CAPTURES = FIXTURES / "resolvers"
MANIFEST = Path(__file__).resolve().parents[1] / "plugins" / "manifests" / "resolvers.json"
ARXIV_PDF = FIXTURES / "arxiv-2609.21174v1.pdf"
LECTURE_NOTES = FIXTURES / "lecture-notes.pdf"
HOMEPAGE = "https://www.math.example.edu/~author/"

type Outcome = Resolved | Unidentified | ResolverFailed


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


@pytest.fixture
def replay_manifest(replay: str, tmp_path: Path) -> Path:
    """The shipped manifest with each plugin's upstream base URL pointed at the replay server.

    The shipped commands resolve their scripts against the shipped manifest's directory, so
    the copy carries them as absolute paths.
    """
    shipped = load_manifest(MANIFEST)
    plugins = [plugin.model_copy(update={"command": [plugin.command[0], str((MANIFEST.parent / plugin.command[1]).resolve()), replay]}) for plugin in shipped.plugins]
    path = tmp_path / "manifests" / "resolvers.json"
    path.parent.mkdir()
    path.write_text(PluginManifest(plugins=plugins).model_dump_json())
    return path


def capture(capsys: pytest.CaptureFixture[str], root: Path, pdf: Path, name: str, source_url: str) -> str:
    app(["capture", str(root), str(pdf), f"{name}.pdf", f"{HOMEPAGE}{name}.pdf", source_url, name], result_action="return_value")
    capsys.readouterr()
    return name


def resolve(capsys: pytest.CaptureFixture[str], root: Path, key: str, manifest: Path) -> Outcome:
    app(["resolve", str(root), key, str(manifest)], result_action="return_value")
    return TypeAdapter(Outcome).validate_json(capsys.readouterr().out)


def fields(bibtex: str) -> dict[str, str]:
    library = bibtexparser.parse_string(bibtex, append_middleware=[LatexDecodingMiddleware()])
    assert len(library.entries) == 1, bibtex
    entry = library.entries[0]
    return {"ENTRYTYPE": entry.entry_type, **{field.key.lower(): field.value for field in entry.fields}}


def test_an_arxiv_pdf_from_an_author_homepage_resolves_through_the_id_arxiv_embedded_in_it(capsys: pytest.CaptureFixture[str], tmp_path: Path, replay_manifest: Path) -> None:
    root = tmp_path / "bucket"
    root.mkdir()
    key = capture(capsys, root, ARXIV_PDF, "cyclicity", f"{HOMEPAGE}papers.html")

    outcome = resolve(capsys, root, key, replay_manifest)

    assert isinstance(outcome, Resolved)
    assert (outcome.plugin_id, outcome.identifier) == ("arxiv", "https://arxiv.org/abs/2609.21174v1")
    entry = fields(outcome.bibtex)
    assert entry["title"] == "On The Cyclicity of Algebraic Lattices"
    # arXiv's natbib `archivePrefix` arrives as biblatex `eprinttype`, which Zotero's BibTeX import keeps.
    assert (entry["eprinttype"], entry["eprint"], entry["eprintclass"]) == ("arXiv", "2609.21174", "math.NT")
    assert "archiveprefix" not in entry
    # arXiv's BibTeX export has no abstract; it comes from the summary of the API's Atom entry.
    assert entry["abstract"].startswith("This work presents theoretical advances in the study of cyclic and quasi-cyclic lattices.")


def test_a_source_url_on_a_resolver_host_wins_over_the_identifiers_inside_the_pdf(capsys: pytest.CaptureFixture[str], tmp_path: Path, replay_manifest: Path) -> None:
    root = tmp_path / "bucket"
    root.mkdir()
    key = capture(capsys, root, ARXIV_PDF, "sphere-packing", "https://doi.org/10.4007/annals.2017.185.3.7")

    outcome = resolve(capsys, root, key, replay_manifest)

    assert isinstance(outcome, Resolved)
    assert (outcome.plugin_id, outcome.identifier) == ("doi", "https://doi.org/10.4007/annals.2017.185.3.7")
    entry = fields(outcome.bibtex)
    assert (entry["ENTRYTYPE"], entry["doi"], entry["journal"]) == ("article", "10.4007/annals.2017.185.3.7", "Annals of Mathematics")


def test_a_zbmath_source_page_resolves_to_an_article_built_from_the_zbmath_record(capsys: pytest.CaptureFixture[str], tmp_path: Path, replay_manifest: Path) -> None:
    root = tmp_path / "bucket"
    root.mkdir()
    key = capture(capsys, root, LECTURE_NOTES, "fuzzy-sets", "https://zbmath.org/?q=an:0139.24606")

    outcome = resolve(capsys, root, key, replay_manifest)

    assert isinstance(outcome, Resolved)
    assert outcome.plugin_id == "zbmath"
    entry = fields(outcome.bibtex)
    assert entry["ENTRYTYPE"] == "article"
    assert (entry["title"], entry["author"], entry["year"]) == ("Fuzzy sets", "Zadeh, L. A.", "1965")
    # Journal, volume and DOI come from the series entry and the link list of the zbMATH record.
    assert (entry["journal"], entry["volume"], entry["pages"]) == ("Information and Control", "8", "338–353")
    assert entry["doi"] == "10.1016/S0019-9958(65)90241-X"


def test_a_book_pdf_carrying_prism_isbn_resolves_to_a_book_from_the_edition_and_author_records(
    capsys: pytest.CaptureFixture[str], tmp_path: Path, replay_manifest: Path
) -> None:
    # A publisher's book PDF: its XMP names the ISBN under PRISM.
    book = tmp_path / "hartshorne.pdf"
    with pikepdf.open(LECTURE_NOTES) as pdf:
        with pdf.open_metadata() as xmp:
            xmp["{http://prismstandard.org/namespaces/basic/2.0/}isbn"] = "978-0-387-90244-9"
        pdf.save(book)
    root = tmp_path / "bucket"
    root.mkdir()
    key = capture(capsys, root, book, "hartshorne", f"{HOMEPAGE}books.html")

    outcome = resolve(capsys, root, key, replay_manifest)

    assert isinstance(outcome, Resolved)
    assert (outcome.plugin_id, outcome.identifier) == ("isbn", "978-0-387-90244-9")
    entry = fields(outcome.bibtex)
    assert entry["ENTRYTYPE"] == "book"
    assert (entry["author"], entry["publisher"], entry["year"], entry["isbn"]) == ("Robin Hartshorne", "Springer", "1997", "9780387902449")


def test_a_pdf_with_no_identifier_is_unidentified_and_no_plugin_runs(capsys: pytest.CaptureFixture[str], tmp_path: Path, replay_manifest: Path) -> None:
    root = tmp_path / "bucket"
    root.mkdir()
    key = capture(capsys, root, LECTURE_NOTES, "lecture-notes", f"{HOMEPAGE}teaching.html")

    outcome = resolve(capsys, root, key, replay_manifest)

    assert outcome == Unidentified(key=key, candidates=[f"{HOMEPAGE}teaching.html", f"{HOMEPAGE}lecture-notes.pdf"])


def test_an_upstream_refusal_is_a_failed_outcome_carrying_the_plugin_exit(capsys: pytest.CaptureFixture[str], tmp_path: Path, replay_manifest: Path) -> None:
    root = tmp_path / "bucket"
    root.mkdir()
    key = capture(capsys, root, LECTURE_NOTES, "unknown-preprint", "https://arxiv.org/abs/2609.99999")

    outcome = resolve(capsys, root, key, replay_manifest)

    assert isinstance(outcome, ResolverFailed)
    assert (outcome.plugin_id, outcome.identifier) == ("arxiv", "https://arxiv.org/abs/2609.99999")
    assert outcome.exit_code != 0


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
    doi = next(plugin for plugin in load_manifest(MANIFEST).plugins if plugin.id == "doi")
    command = [doi.command[0], str((MANIFEST.parent / doi.command[1]).resolve()), f"http://127.0.0.1:{server.server_address[1]}"]

    completed = subprocess.run(command, input="10.4007/annals.2017.185.3.7", capture_output=True, text=True, check=False)
    server.shutdown()

    assert completed.returncode == 1
    assert completed.stdout == ""
    assert completed.stderr.startswith(reason)


def test_every_shipped_resolver_command_resolves_from_the_manifest_directory() -> None:
    for plugin in load_manifest(MANIFEST).plugins:
        assert (MANIFEST.parent / plugin.command[1]).resolve().is_file(), plugin.id


def test_remove_moves_the_pdf_and_its_extraction_to_the_desktop_trash(capsys: pytest.CaptureFixture[str], tmp_path: Path) -> None:
    root = tmp_path / "bucket"
    root.mkdir()
    removed = capture(capsys, root, LECTURE_NOTES, "lecture-notes", f"{HOMEPAGE}teaching.html")
    kept = capture(capsys, root, ARXIV_PDF, "cyclicity", f"{HOMEPAGE}papers.html")
    (root / f"{removed}.md").write_text("# Lattices\n")
    (root / f"{removed}.extraction").mkdir()
    (root / f"{removed}.extraction" / "content_list.json").write_text("[]")

    # The desktop trash of a data home on the bucket's own file system.
    data_home = tmp_path / "data"
    pdfbucket = Path(sys.executable).with_name("pdfbucket")
    subprocess.run([pdfbucket, "remove", root, removed], env={**os.environ, "XDG_DATA_HOME": str(data_home)}, check=True, capture_output=True)

    trash = data_home / "Trash" / "files"
    assert sorted(path.name for path in trash.iterdir()) == ["lecture-notes.extraction", "lecture-notes.md", "lecture-notes.pdf"]
    assert (trash / "lecture-notes.pdf").read_bytes().startswith(b"%PDF-")
    app(["list", str(root)], result_action="return_value")
    assert [item.key for item in TypeAdapter(list[StoredItem]).validate_json(capsys.readouterr().out)] == [kept]
