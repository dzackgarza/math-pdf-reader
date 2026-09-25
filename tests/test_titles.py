"""The pikepdf commands the server runs (`pdfbucket <command>`), through their command line:
provenance embedded exactly as given, what a PDF says about itself, and recorded metadata."""

import subprocess
import sys
from hashlib import sha256
from pathlib import Path

import pikepdf
from pydantic import TypeAdapter

from pdfbucket.models import PdfRecord, Read, ReadOutcome, StoreFailure

FIXTURES = Path(__file__).resolve().parent / "fixtures"
ARXIV_PDF = FIXTURES / "arxiv-2609.21174v1.pdf"
LECTURE_NOTES = FIXTURES / "lecture-notes.pdf"
PROBLEM_SET = FIXTURES / "problem-set.pdf"
HOMEPAGE = "https://www.math.example.edu/~author/"
ABSTRACT = "We prove that no packing of unit balls in $\\mathbb{R}^8$ is denser than $E_8$."
XMP_PROVENANCE = "{https://github.com/dzackgarza/math-pdf-reader/ns/provenance/1.0/}"
PDFBUCKET = Path(sys.executable).with_name("pdfbucket")
READ = TypeAdapter(list[ReadOutcome])


def run(*args: str | Path, stdin: bytes = b"") -> subprocess.CompletedProcess[bytes]:
    return subprocess.run([PDFBUCKET, *args], input=stdin, capture_output=True, check=False)


def embed(
    tmp_path: Path,
    pdf: Path,
    name: str,
    title_hint: str,
    *,
    source_url: str | None = f"{HOMEPAGE}index.html",
    pdf_url: str | None = None,
) -> Path:
    args = [
        f"--pdf-url={pdf_url or f'{HOMEPAGE}{name}.pdf'}",
        "--captured-at=2026-09-25T10:00:00.123Z",
        f"--original-sha256={sha256(pdf.read_bytes()).hexdigest()}",
        f"--title-hint={title_hint}",
    ]
    if source_url is not None:
        args.append(f"--source-url={source_url}")
    embedded = run("embed-provenance", *args, stdin=pdf.read_bytes())
    assert embedded.returncode == 0, embedded.stderr
    stored = tmp_path / f"{name}.pdf"
    stored.write_bytes(embedded.stdout)
    return stored


def read(*paths: Path) -> list[ReadOutcome]:
    listed = run("read", "--", *paths)
    assert listed.returncode == 0, listed.stderr
    return READ.validate_json(listed.stdout)


def record(path: Path) -> PdfRecord:
    [outcome] = read(path)
    assert isinstance(outcome, Read), outcome
    return outcome.record


def test_provenance_is_embedded_and_read_back_as_the_exact_text_given(tmp_path: Path) -> None:
    # Host case, an escaped space and a trailing dot survive: nothing normalizes the URL.
    pdf_url = "https://Example.ORG/papers/Lattice%20Notes.pdf"
    stored = embed(
        tmp_path,
        LECTURE_NOTES,
        "notes",
        "Lattices",
        pdf_url=pdf_url,
        source_url="https://www.math.example.edu./~author/",
    )

    provenance = record(stored).provenance

    assert (provenance.pdf_url, provenance.source_url) == (pdf_url, "https://www.math.example.edu./~author/")
    assert provenance.captured_at == "2026-09-25T10:00:00.123Z"
    with pikepdf.open(stored) as pdf:
        docinfo = {str(k): str(v) for k, v in pdf.docinfo.items()}
        xmp_url = str(pdf.open_metadata()[f"{XMP_PROVENANCE}pdf-url"])
    assert docinfo["/PDFBucketPDFURL"] == pdf_url
    assert xmp_url == pdf_url


def test_a_capture_with_no_linking_page_carries_no_source_url(tmp_path: Path) -> None:
    stored = embed(tmp_path, LECTURE_NOTES, "notes", "Lattices", source_url=None)

    assert record(stored).provenance.source_url is None
    with pikepdf.open(stored) as pdf:
        assert "/PDFBucketSourceURL" not in pdf.docinfo


def test_a_pdf_with_its_own_metadata_title_reads_back_under_that_title(tmp_path: Path) -> None:
    stored = embed(tmp_path, ARXIV_PDF, "cyclicity", "View PDF")

    item = record(stored)

    assert (item.title.text, item.title.source) == ("On The Cyclicity of Algebraic Lattices", "pdf-metadata")
    assert item.provenance.title_hint == "View PDF"
    assert item.pages == 9


def test_a_pdf_without_a_metadata_title_reads_back_under_the_capture_hint_then_the_file_name(tmp_path: Path) -> None:
    hinted = record(embed(tmp_path, LECTURE_NOTES, "hinted", "Lecture notes on lattices"))
    unhinted = record(embed(tmp_path, PROBLEM_SET, "problem-set-3", " "))

    assert (hinted.title.text, hinted.title.source) == ("Lecture notes on lattices", "capture-hint")
    assert (unhinted.title.text, unhinted.title.source) == ("problem-set-3.pdf", "filename")


def test_recorded_resolver_metadata_is_written_into_the_pdf_and_leaves_the_provenance_as_captured(
    tmp_path: Path,
) -> None:
    stored = embed(tmp_path, LECTURE_NOTES, "notes", "Lecture notes on lattices")
    before = record(stored)

    recorded = run(
        "embed-metadata",
        "--author=Maryna Viazovska",
        "--author=Henry Cohn",
        "--year=2017",
        f"--abstract={ABSTRACT}",
        "--",
        stored,
        "Ten Lectures on Integral Lattices",
        "resolver",
    )
    assert recorded.returncode == 0, recorded.stderr
    stored.write_bytes(recorded.stdout)
    after = record(stored)

    assert (after.title.text, after.title.source) == ("Ten Lectures on Integral Lattices", "resolver")
    assert after.authors == ["Maryna Viazovska", "Henry Cohn"]
    assert (after.year, after.abstract) == (2017, ABSTRACT)
    assert after.provenance == before.provenance
    # Independent read: any PDF tool sees the title, and the bucket's source key says where it came from.
    with pikepdf.open(stored) as pdf:
        docinfo = {str(k): str(v) for k, v in pdf.docinfo.items()}
        with pdf.open_metadata(set_pikepdf_as_editor=False) as xmp:
            dc_title = str(xmp["dc:title"])
            dc_creator = list(xmp["dc:creator"])
            dc_description = str(xmp["dc:description"])
    assert (docinfo["/Title"], dc_title) == ("Ten Lectures on Integral Lattices", "Ten Lectures on Integral Lattices")
    assert docinfo["/PDFBucketTitleSource"] == "resolver"
    assert (docinfo["/Author"], dc_creator) == ("Maryna Viazovska; Henry Cohn", ["Maryna Viazovska", "Henry Cohn"])
    assert dc_description == ABSTRACT


def test_read_reports_each_file_it_cannot_read_beside_the_ones_it_can(tmp_path: Path) -> None:
    stored = embed(tmp_path, LECTURE_NOTES, "notes", "Lattices")
    foreign = tmp_path / "foreign.pdf"
    foreign.write_bytes(PROBLEM_SET.read_bytes())
    torn = tmp_path / "torn.pdf"
    torn.write_bytes(stored.read_bytes()[:200])
    wrong_authors = tmp_path / "authors.pdf"
    with pikepdf.open(stored) as pdf:
        pdf.docinfo["/PDFBucketAuthors"] = '"Maryna Viazovska"'
        pdf.save(wrong_authors)

    outcomes = read(foreign, stored, torn, wrong_authors)

    assert [outcome.status for outcome in outcomes] == ["unreadable", "read", "unreadable", "unreadable"]


def test_a_command_on_a_pdf_it_cannot_read_exits_3_with_a_typed_failure(tmp_path: Path) -> None:
    torn = tmp_path / "torn.pdf"
    torn.write_bytes(LECTURE_NOTES.read_bytes()[:200])

    failed = run("embed-metadata", "--", torn, "Title", "resolver")
    refused = run(
        "embed-provenance",
        "--pdf-url=https://example.org/a.pdf",
        "--captured-at=2026-09-25T10:00:00Z",
        f"--original-sha256={'0' * 64}",
        "--title-hint=A",
        stdin=b"<html></html>",
    )

    assert (failed.returncode, StoreFailure.model_validate_json(failed.stdout).kind) == (3, "unreadable_pdf")
    assert (refused.returncode, StoreFailure.model_validate_json(refused.stdout).kind) == (3, "unreadable_pdf")
