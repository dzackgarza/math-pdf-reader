"""Where a PDF page's text lies in a Markdown extraction of the whole PDF.

An extraction has no page marks, and its text differs from the PDF's own (LaTeX or OCR against
a typeset page: math, hyphenation, running heads). Matching the page's words approximately finds
the place anyway. rapidfuzz's `partial_ratio_alignment` finds where a short needle best fits a
long haystack (https://rapidfuzz.github.io/RapidFuzz/Usage/fuzz.html#partial-ratio-alignment).
The head and the tail of the page's text are each matched, the head first inside a window around
the place the page's number predicts, so a phrase that repeats elsewhere does not mislead.
"""

from __future__ import annotations

import bisect
import re
from dataclasses import dataclass
from pathlib import Path

import pymupdf
from rapidfuzz import fuzz

WORD = re.compile(r"[a-z]{3,}")
NEEDLE_WORDS = 40
MIN_SCORE = 70
# How far from the proportional place, as a fraction of the extraction, the head may match.
WINDOW = 0.25
# How many pages' worth of the extraction the tail may lie after the head.
PAGE_SPAN = 2.5


@dataclass(frozen=True)
class Lines:
    """A range of lines of the extraction, counted from 1."""

    first: int
    last: int
    # The nearest heading at or before the first line, as the extraction writes it; None when
    # no heading precedes.
    heading: str | None


@dataclass(frozen=True)
class Words:
    """The lowercase words of a text joined by single spaces, where each starts in the joined
    text, and where each starts in the original."""

    joined: str
    starts: list[int]
    origins: list[int]

    @staticmethod
    def of(text: str) -> Words:
        found = list(WORD.finditer(text.lower()))
        starts: list[int] = []
        position = 0
        for match in found:
            starts.append(position)
            position += len(match.group()) + 1
        return Words(
            " ".join(match.group() for match in found),
            starts,
            [match.start() for match in found],
        )


def locate(pdf: Path, markdown: Path, page: int) -> Lines | None:
    """The lines of MARKDOWN that PDF's PAGE (from 1) most likely covers, or None when its
    words match nowhere (a page of figures or of formulas only)."""
    with pymupdf.open(pdf) as document:
        count = document.page_count
        if not 1 <= page <= count:
            raise IndexError(f"the PDF has {count} pages, not a page {page}")
        words = Words.of(document[page - 1].get_text()).joined.split(" ")
    if len(words) < NEEDLE_WORDS:
        return None
    text = markdown.read_text(encoding="utf-8")
    haystack = Words.of(text)
    size = len(haystack.joined)
    head = " ".join(words[:NEEDLE_WORDS])
    tail = " ".join(words[-NEEDLE_WORDS:])

    expected = (page - 1) / count * size
    low = max(0, int(expected - WINDOW * size))
    high = min(size, int(expected + (WINDOW + 1 / count) * size))
    found = fuzz.partial_ratio_alignment(head, haystack.joined[low:high], score_cutoff=MIN_SCORE)
    if found is not None:
        start = low + found.dest_start
    else:
        found = fuzz.partial_ratio_alignment(head, haystack.joined, score_cutoff=MIN_SCORE)
        if found is None:
            return None
        start = found.dest_start
    span = int(PAGE_SPAN * size / count)
    after = fuzz.partial_ratio_alignment(tail, haystack.joined[start : start + span], score_cutoff=MIN_SCORE)
    end = start if after is None else start + after.dest_end

    def line_of(position: int) -> int:
        index = max(0, bisect.bisect_right(haystack.starts, position) - 1)
        return text.count("\n", 0, haystack.origins[index]) + 1

    first = line_of(start)
    headings = [
        line for line in text.splitlines()[:first] if line.startswith("#")
    ]
    return Lines(first, line_of(max(start, end - 1)), headings[-1] if headings else None)
