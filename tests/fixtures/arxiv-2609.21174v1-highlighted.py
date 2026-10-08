# /// script
# requires-python = ">=3.14"
# dependencies = ["pikepdf"]
# ///
"""Writes arxiv-2609.21174v1-highlighted.pdf: arxiv-2609.21174v1.pdf with one highlight on its
first page, as the reader saves a highlight into the file."""

from pathlib import Path

import pikepdf

here = Path(__file__).parent
with pikepdf.open(here / "arxiv-2609.21174v1.pdf") as pdf:
    page = pdf.pages[0]
    rect = [72, 700, 300, 714]
    highlight = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name.Annot,
            Subtype=pikepdf.Name.Highlight,
            Rect=rect,
            QuadPoints=[72, 714, 300, 714, 72, 700, 300, 700],
            C=[1, 1, 0],
            Contents="the main theorem",
        )
    )
    page.Annots = pdf.make_indirect(pikepdf.Array([*page.get("/Annots", []), highlight]))
    pdf.save(here / "arxiv-2609.21174v1-highlighted.pdf", deterministic_id=True)
