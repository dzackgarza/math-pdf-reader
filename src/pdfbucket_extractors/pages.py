"""Page ranges and PDF chunks for providers with a per-request page limit."""

from __future__ import annotations

from pathlib import Path

import pikepdf


def page_count(pdf: Path) -> int:
    with pikepdf.open(pdf) as document:
        return len(document.pages)


def page_ranges(total_pages: int, pages_per_chunk: int) -> list[tuple[int, int]]:
    """Half-open, zero-based page ranges covering every page, each at most PAGES_PER_CHUNK long."""
    assert total_pages > 0, f"PDF page count must be positive: {total_pages}"
    assert pages_per_chunk > 0, f"chunk size must be positive: {pages_per_chunk}"
    return [(start, min(start + pages_per_chunk, total_pages)) for start in range(0, total_pages, pages_per_chunk)]


def split_pdf(pdf: Path, ranges: list[tuple[int, int]], directory: Path) -> list[Path]:
    """Write one PDF per range into DIRECTORY, in range order."""
    chunks: list[Path] = []
    with pikepdf.open(pdf) as source:
        for start, stop in ranges:
            chunk = pikepdf.new()
            chunk.pages.extend(source.pages[start:stop])
            path = directory / f"pages-{start + 1:04d}-{stop:04d}.pdf"
            chunk.save(path)
            chunks.append(path)
    return chunks
