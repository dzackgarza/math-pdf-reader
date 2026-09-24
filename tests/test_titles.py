from pathlib import Path

import pikepdf
import pytest

from pdfbucket.cli import app
from pdfbucket.models import StoredItem

FIXTURES = Path(__file__).resolve().parent / "fixtures"
ARXIV_PDF = FIXTURES / "arxiv-2609.21174v1.pdf"
LECTURE_NOTES = FIXTURES / "lecture-notes.pdf"
HOMEPAGE = "https://www.math.example.edu/~author/"
XMP_PROVENANCE = "{https://github.com/dzackgarza/math-pdf-reader/ns/provenance/1.0/}"


def capture(capsys: pytest.CaptureFixture[str], root: Path, pdf: Path, key: str, title_hint: str) -> None:
    app(["capture", str(root), str(pdf), f"{key}.pdf", f"{HOMEPAGE}{key}.pdf", f"{HOMEPAGE}index.html", title_hint], result_action="return_value")
    capsys.readouterr()


def describe(capsys: pytest.CaptureFixture[str], root: Path, key: str) -> StoredItem:
    app(["describe", str(root), key], result_action="return_value")
    return StoredItem.model_validate_json(capsys.readouterr().out)


def test_a_pdf_with_its_own_metadata_title_reads_back_under_that_title(capsys: pytest.CaptureFixture[str], tmp_path: Path) -> None:
    capture(capsys, tmp_path, ARXIV_PDF, "cyclicity", "View PDF")

    item = describe(capsys, tmp_path, "cyclicity")

    assert item.title.text == "On The Cyclicity of Algebraic Lattices"
    assert item.title.source == "pdf-metadata"
    assert item.provenance.title_hint == "View PDF"


def test_a_pdf_without_a_metadata_title_reads_back_under_the_capture_hint_then_the_filename(capsys: pytest.CaptureFixture[str], tmp_path: Path) -> None:
    capture(capsys, tmp_path, LECTURE_NOTES, "hinted", "Lecture notes on lattices")
    capture(capsys, tmp_path, FIXTURES / "problem-set.pdf", "problem-set-3", "")

    hinted = describe(capsys, tmp_path, "hinted")
    unhinted = describe(capsys, tmp_path, "problem-set-3")

    assert (hinted.title.text, hinted.title.source) == ("Lecture notes on lattices", "capture-hint")
    assert (unhinted.title.text, unhinted.title.source) == ("problem-set-3.pdf", "filename")


def test_recorded_resolver_title_and_authors_are_written_into_the_pdf_and_leave_the_provenance_as_captured(capsys: pytest.CaptureFixture[str], tmp_path: Path) -> None:
    capture(capsys, tmp_path, LECTURE_NOTES, "notes", "Lecture notes on lattices")
    before = describe(capsys, tmp_path, "notes")

    app(["metadata", str(tmp_path), "notes", "Ten Lectures on Integral Lattices", "resolver", "--author", "Maryna Viazovska", "--author", "Henry Cohn"], result_action="return_value")
    recorded = StoredItem.model_validate_json(capsys.readouterr().out)
    after = describe(capsys, tmp_path, "notes")

    assert recorded == after
    assert (after.title.text, after.title.source) == ("Ten Lectures on Integral Lattices", "resolver")
    assert after.authors == ["Maryna Viazovska", "Henry Cohn"]
    assert after.provenance == before.provenance
    # Independent read: any PDF tool sees the title, and the bucket's source key says where it came from.
    with pikepdf.open(tmp_path / "notes.pdf") as pdf:
        docinfo = {str(k): str(v) for k, v in pdf.docinfo.items()}
        with pdf.open_metadata(set_pikepdf_as_editor=False) as xmp:
            dc_title = str(xmp["dc:title"])
            xmp_source = str(xmp[f"{XMP_PROVENANCE}title-source"])
            dc_creator = list(xmp["dc:creator"])
    assert docinfo["/Title"] == "Ten Lectures on Integral Lattices"
    assert dc_title == "Ten Lectures on Integral Lattices"
    assert docinfo["/PDFBucketTitleSource"] == "resolver"
    assert docinfo["/Author"] == "Maryna Viazovska; Henry Cohn"
    assert dc_creator == ["Maryna Viazovska", "Henry Cohn"]
    assert xmp_source == "resolver"
    assert docinfo["/PDFBucketTitleHint"] == "Lecture notes on lattices"
