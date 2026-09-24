"""First-page thumbnails, rendered with MuPDF (PyMuPDF) and written as PNG."""

from __future__ import annotations

from pathlib import Path

import pymupdf


def render_first_page(pdf: Path, out: Path, width: int) -> None:
    """Write PDF's first page WIDTH pixels wide as a PNG at OUT; the file appears only complete."""
    with pymupdf.open(pdf) as document:
        page = document[0]
        scale = width / page.rect.width
        pixmap = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale))
        # The scale rounds to whole pixels; the width asked for is the width delivered.
        if pixmap.width != width:
            pixmap = pymupdf.Pixmap(pixmap, width, round(pixmap.height * width / pixmap.width))
        partial = out.with_suffix(".partial")
        pixmap.save(partial, output="png")
    partial.replace(out)
