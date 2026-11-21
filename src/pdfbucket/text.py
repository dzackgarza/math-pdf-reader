"""A PDF's text, extracted with MuPDF (PyMuPDF), one marked section per page."""

from __future__ import annotations

from pathlib import Path

import pymupdf


def page_text(pdf: Path, page: int | None) -> str:
    """The text of PDF's PAGE (counted from 1), or of every page when PAGE is None.

    Each page's text follows a `--- page N of M ---` line, so a reader of the text can tell
    where a page begins and cite it.
    """
    with pymupdf.open(pdf) as document:
        count = document.page_count
        numbers = range(1, count + 1) if page is None else [page]
        for number in numbers:
            if not 1 <= number <= count:
                raise IndexError(f"the PDF has {count} pages, not a page {number}")
        return "\n".join(
            f"--- page {number} of {count} ---\n{document[number - 1].get_text()}"
            for number in numbers
        )
