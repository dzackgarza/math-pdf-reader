# /// script
# requires-python = ">=3.14"
# dependencies = ["reportlab"]
# ///
"""Writes japanese-text.pdf: one page of Japanese text in a CID font the PDF does not embed
(reportlab's HeiseiMin-W3, Adobe-Japan1), so a viewer draws it with a fallback font."""

from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen.canvas import Canvas

pdfmetrics.registerFont(UnicodeCIDFont("HeiseiMin-W3"))
canvas = Canvas(str(Path(__file__).with_suffix(".pdf")), pagesize=A4, invariant=True)
canvas.setTitle("Lattice notes in Japanese")
canvas.setFont("HeiseiMin-W3", 24)
canvas.drawString(72, 760, "整数格子と二次形式")
canvas.drawString(72, 720, "ユニモジュラー格子の分類")
canvas.showPage()
canvas.save()
