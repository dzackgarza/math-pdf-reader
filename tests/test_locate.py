import json
import random
import subprocess
import sys
from pathlib import Path

import pymupdf
import pytest

PDFBUCKET = Path(sys.executable).with_name("pdfbucket")
PAGES = 8
WORDS = (
    "lattice discriminant unimodular reflection genus orthogonal isometry sublattice quotient "
    "theorem proof invariant spinor characteristic polynomial residue torsion cohomology sheaf "
    "moduli stack derived symplectic cotangent complex obstruction deformation filtration weight"
).split()


def prose(seed: int, count: int = 90) -> list[str]:
    generator = random.Random(seed)
    return [generator.choice(WORDS) for _ in range(count)]


@pytest.fixture
def paper(tmp_path: Path) -> tuple[Path, Path, list[list[str]]]:
    """A PDF of PAGES pages of distinct prose, and an extraction of it: one section per page,
    one paragraph per sentence, with formulas the PDF text lacks and a heading above each."""
    pages = [prose(page) for page in range(PAGES)]
    document = pymupdf.open()
    for words in pages:
        page = document.new_page()
        page.insert_textbox(pymupdf.Rect(40, 40, 560, 800), " ".join(words), fontsize=11)
    pdf = tmp_path / "paper.pdf"
    document.save(pdf)
    lines: list[str] = ["# A paper", ""]
    for number, words in enumerate(pages, start=1):
        lines += [f"## Section {number}", ""]
        for start in range(0, len(words), 15):
            lines += [" ".join(words[start : start + 15]) + f" $x_{start} + y^2$.", ""]
    markdown = tmp_path / "paper.md"
    markdown.write_text("\n".join(lines), encoding="utf-8")
    return pdf, markdown, pages


def locate(pdf: Path, markdown: Path, page: int) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(PDFBUCKET), "locate", "--page", str(page), "--", str(pdf), str(markdown)],
        capture_output=True,
        text=True,
        check=False,
    )


@pytest.mark.parametrize("page", range(1, PAGES + 1))
def test_a_page_is_placed_in_its_own_section_of_the_extraction(
    paper: tuple[Path, Path, list[list[str]]], page: int
) -> None:
    pdf, markdown, _ = paper

    done = locate(pdf, markdown, page)

    assert done.returncode == 0, done.stderr
    found = json.loads(done.stdout)
    assert found["heading"] == f"## Section {page}"
    text = markdown.read_text(encoding="utf-8").splitlines()
    assert text[found["first"] - 1].startswith(tuple(WORDS))
    assert found["first"] <= found["last"]


def test_a_page_whose_words_are_nowhere_in_the_extraction_is_not_placed(
    paper: tuple[Path, Path, list[list[str]]], tmp_path: Path
) -> None:
    pdf, _, _ = paper
    other = tmp_path / "other.md"
    other.write_text("# Other\n\n" + " ".join(["unrelated"] * 400) + "\n", encoding="utf-8")

    done = locate(pdf, other, 3)

    assert done.returncode == 0, done.stderr
    assert json.loads(done.stdout) is None


def test_a_page_the_pdf_lacks_is_refused_with_the_page_count(
    paper: tuple[Path, Path, list[list[str]]],
) -> None:
    pdf, markdown, _ = paper

    done = locate(pdf, markdown, PAGES + 1)

    assert done.returncode == 4
    assert f"the PDF has {PAGES} pages" in done.stderr
