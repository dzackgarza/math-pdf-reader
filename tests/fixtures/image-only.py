"""Writes image-only.pdf: two pages of drawn shapes and no text, with no outline, as a scan
without OCR is: nothing to search and nothing to list in an outline."""

from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen.canvas import Canvas

canvas = Canvas(str(Path(__file__).with_suffix(".pdf")), pagesize=A4, invariant=True)
canvas.setTitle("A scanned page without text")
for page in range(2):
    for line in range(24):
        canvas.rect(72, 760 - line * 28, 300 + (line * 37 + page * 50) % 150, 10, stroke=0, fill=1)
    canvas.showPage()
canvas.save()
