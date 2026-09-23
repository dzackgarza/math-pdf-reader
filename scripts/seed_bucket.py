"""Seed a bucket root with COUNT PDFs made from committed fixtures, stored through the real store.

Run inside the project environment: `uv run --locked python scripts/seed_bucket.py ROOT COUNT`.
Every PDF is a copy of a committed fixture PDF (tests/fixtures) with its own document title;
its provenance (PDF URL, source page, capture time, original hash) is embedded by
`pdfbucket.store.store_pdf`, exactly as a browser capture would. Titles, sources and capture
times are synthetic and deterministic.
"""

from __future__ import annotations

import random
import sys
from datetime import UTC, datetime, timedelta
from io import BytesIO
from pathlib import Path

import pikepdf
from pydantic import HttpUrl

from pdfbucket.models import CaptureRequest
from pdfbucket.store import store_pdf

SUBJECTS = [
    "flips",
    "K3 surfaces",
    "Enriques surfaces",
    "even unimodular lattices",
    "Mori dream spaces",
    "abelian varieties",
    "hyperkähler manifolds",
    "theta functions",
    "modular forms",
    "Weyl groups",
    "Coxeter polytopes",
    "log canonical thresholds",
    "Fano threefolds",
    "moduli of curves",
    "quadratic forms",
    "elliptic fibrations",
]
CLAIMS = [
    "Existence of {subject} in dimension {n}",
    "On the birational geometry of {subject}",
    "A survey of {subject}",
    "Boundedness results for {subject}",
    "Automorphisms of {subject} and reflection groups",
    "Lectures on {subject}",
    "Counting {subject} over finite fields",
    "The cone conjecture for {subject}",
    "Mirror symmetry for {subject}",
    "Degenerations of {subject} and period maps",
]
SOURCES = [
    ("https://arxiv.org/abs/{id}", "https://arxiv.org/pdf/{id}"),
    ("https://math.berkeley.edu/~author/papers.html", "https://math.berkeley.edu/~author/{id}.pdf"),
    ("https://projecteuclid.org/journals/item/{id}", "https://projecteuclid.org/download/{id}.pdf"),
    ("https://www.ams.org/journals/item/{id}", "https://www.ams.org/journals/item/{id}.pdf"),
    ("https://www.numdam.org/item/{id}/", "https://www.numdam.org/item/{id}.pdf"),
]
NEWEST_CAPTURE = datetime(2026, 9, 20, 14, 30, tzinfo=UTC)
FIXTURES = Path(__file__).resolve().parents[1] / "tests" / "fixtures"
# Committed PDFs the seeded items are copies of; nothing is downloaded.
FIXTURE_PDFS = ["lecture-notes.pdf", "ten-page-notes.pdf", "long-notes.pdf", "problem-set.pdf"]


def titled_copy(fixture: bytes, title: str) -> bytes:
    """The committed fixture PDF with TITLE as its document title, so each seeded PDF has its own bytes."""
    output = BytesIO()
    with pikepdf.open(BytesIO(fixture)) as pdf:
        pdf.docinfo["/Title"] = title
        pdf.save(output)
    return output.getvalue()


def seed(root: Path, count: int) -> None:
    rng = random.Random(8)
    fixtures = [(FIXTURES / name).read_bytes() for name in FIXTURE_PDFS]
    root.mkdir(parents=True, exist_ok=True)
    for index in range(count):
        title = rng.choice(CLAIMS).format(subject=rng.choice(SUBJECTS), n=rng.randint(2, 24))
        identifier = f"{2400 + index // 400}.{10000 + index:05d}"
        source, pdf_url = rng.choice(SOURCES)
        request = CaptureRequest(
            pdf_url=HttpUrl(pdf_url.format(id=identifier)),
            source_url=HttpUrl(source.format(id=identifier)),
            title_hint=title,
        )
        captured_at = NEWEST_CAPTURE - timedelta(hours=index * 7 + rng.randint(0, 6), minutes=rng.randint(0, 59))
        fixture = fixtures[index % len(fixtures)]
        store_pdf(root, titled_copy(fixture, title), request, f"{identifier}.pdf", captured_at)


if __name__ == "__main__":
    seed(Path(sys.argv[1]), int(sys.argv[2]))
