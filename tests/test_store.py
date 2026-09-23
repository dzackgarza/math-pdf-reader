from datetime import datetime
from hashlib import sha256
from pathlib import Path

import pikepdf
import pytest
from pydantic import TypeAdapter

from pdfbucket.cli import app
from pdfbucket.models import CaptureResult, StoredItem
from pdfbucket.provenance import MissingProvenanceError
from pdfbucket.store import UnknownKeyError, pdf_path

FIXTURES = Path(__file__).resolve().parent / "fixtures"
LECTURE_NOTES = FIXTURES / "lecture-notes.pdf"
PROBLEM_SET = FIXTURES / "problem-set.pdf"
SOURCE_PAGE = "https://www.math.example.edu/~author/teaching.html"


def run_capture(capsys: pytest.CaptureFixture[str], root: Path, pdf: Path, filename: str, pdf_url: str) -> CaptureResult:
    app(
        ["capture", str(root), str(pdf), filename, pdf_url, SOURCE_PAGE, "Lattices and Quadratic Forms"],
        result_action="return_value",
    )
    return CaptureResult.model_validate_json(capsys.readouterr().out)


def test_capture_embeds_provenance_readable_from_the_file_alone(capsys: pytest.CaptureFixture[str], tmp_path: Path) -> None:
    before = datetime.now().astimezone()
    result = run_capture(capsys, tmp_path, LECTURE_NOTES, "lattices notes.pdf", "https://www.math.example.edu/~author/lattices.pdf")

    stored = tmp_path / "lattices notes.pdf"
    assert [p.name for p in tmp_path.iterdir()] == ["lattices notes.pdf"]
    assert result.existing is False
    assert result.item.key == "lattices notes"
    assert result.stored_sha256 == sha256(stored.read_bytes()).hexdigest()
    assert result.stored_sha256 != sha256(LECTURE_NOTES.read_bytes()).hexdigest()

    # Independent read of the stored file: the provenance is inside the PDF.
    with pikepdf.open(stored) as pdf:
        docinfo = {str(k): str(v) for k, v in pdf.docinfo.items()}
        xmp_source = pdf.open_metadata()["{https://github.com/dzackgarza/math-pdf-reader/ns/provenance/1.0/}source-url"]
        page_count = len(pdf.pages)
    assert docinfo["/PDFBucketPDFURL"] == "https://www.math.example.edu/~author/lattices.pdf"
    assert docinfo["/PDFBucketSourceURL"] == SOURCE_PAGE
    assert xmp_source == SOURCE_PAGE
    assert docinfo["/PDFBucketOriginalSHA256"] == sha256(LECTURE_NOTES.read_bytes()).hexdigest()
    assert docinfo["/PDFBucketTitleHint"] == "Lattices and Quadratic Forms"
    assert before <= datetime.fromisoformat(docinfo["/PDFBucketCapturedAt"]) <= datetime.now().astimezone()
    assert page_count == 2

    app(["describe", str(tmp_path), "lattices notes"], result_action="return_value")
    assert StoredItem.model_validate_json(capsys.readouterr().out) == result.item


def test_recapturing_the_same_pdf_returns_the_stored_item_unchanged(capsys: pytest.CaptureFixture[str], tmp_path: Path) -> None:
    first = run_capture(capsys, tmp_path, LECTURE_NOTES, "lattices.pdf", "https://arxiv.org/pdf/2401.00001")
    second = run_capture(capsys, tmp_path, LECTURE_NOTES, "lattices.pdf", "https://mirror.example.org/lattices.pdf")

    assert second.existing is True
    assert second.item == first.item
    assert second.stored_sha256 == first.stored_sha256
    assert [p.name for p in tmp_path.iterdir()] == ["lattices.pdf"]


def test_a_different_pdf_under_a_taken_key_gets_a_hash_suffixed_key(capsys: pytest.CaptureFixture[str], tmp_path: Path) -> None:
    run_capture(capsys, tmp_path, LECTURE_NOTES, "notes.pdf", "https://example.org/a/notes.pdf")
    other = run_capture(capsys, tmp_path, PROBLEM_SET, "notes.pdf", "https://example.org/b/notes.pdf")
    again = run_capture(capsys, tmp_path, PROBLEM_SET, "notes.pdf", "https://example.org/b/notes.pdf")

    expected_key = f"notes--{sha256(PROBLEM_SET.read_bytes()).hexdigest()[:12]}"
    assert other.item.key == expected_key
    assert str(other.item.provenance.pdf_url) == "https://example.org/b/notes.pdf"
    assert again.existing is True
    assert again.item.key == expected_key
    assert sorted(p.name for p in tmp_path.iterdir()) == sorted(["notes.pdf", f"{expected_key}.pdf"])


@pytest.mark.parametrize("key", ["missing", "../fixtures/lecture-notes", ".."])
def test_keys_that_name_no_stored_pdf_are_rejected(tmp_path: Path, key: str) -> None:
    (tmp_path / "fixtures").mkdir()
    (tmp_path / "fixtures" / "lecture-notes.pdf").write_bytes(LECTURE_NOTES.read_bytes())

    with pytest.raises(UnknownKeyError):
        pdf_path(tmp_path / "fixtures", key)


@pytest.mark.parametrize(
    ("filename", "key"),
    [("2401.00001", "2401.00001"), ("2401.00001v2.pdf", "2401.00001v2"), ("Lecture 3.PDF", "Lecture 3"), ("ch?1:intro.pdf", "ch-1-intro")],
)
def test_the_key_is_the_uploaded_filename_without_its_pdf_suffix(capsys: pytest.CaptureFixture[str], tmp_path: Path, filename: str, key: str) -> None:
    result = run_capture(capsys, tmp_path, LECTURE_NOTES, filename, "https://arxiv.org/pdf/2401.00001")

    assert result.item.key == key
    assert [p.name for p in tmp_path.iterdir()] == [f"{key}.pdf"]


def test_list_reads_every_stored_item_from_the_files_alone(capsys: pytest.CaptureFixture[str], tmp_path: Path) -> None:
    notes = run_capture(capsys, tmp_path, LECTURE_NOTES, "notes.pdf", "https://example.org/notes.pdf")
    problems = run_capture(capsys, tmp_path, PROBLEM_SET, "problems.pdf", "https://example.org/problems.pdf")
    (tmp_path / "organization.json").write_text("{}")

    app(["list", str(tmp_path)], result_action="return_value")
    listed = TypeAdapter(list[StoredItem]).validate_json(capsys.readouterr().out)
    assert listed == [notes.item, problems.item]

    app(["list", str(tmp_path), "problems"], result_action="return_value")
    assert TypeAdapter(list[StoredItem]).validate_json(capsys.readouterr().out) == [problems.item]


def test_list_refuses_a_stored_pdf_without_provenance(capsys: pytest.CaptureFixture[str], tmp_path: Path) -> None:
    run_capture(capsys, tmp_path, LECTURE_NOTES, "notes.pdf", "https://example.org/notes.pdf")
    (tmp_path / "hand-copied.pdf").write_bytes(PROBLEM_SET.read_bytes())

    with pytest.raises(MissingProvenanceError):
        app(["list", str(tmp_path)], result_action="return_value")
