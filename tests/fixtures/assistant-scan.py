"""Print lecture notes with a scanned cover and a permanently obscured signature."""

import sys

import pymupdf


def scanned_cover(notes: str, catalog_number: str) -> bytes:
    with pymupdf.open() as cover, pymupdf.open(notes) as paper:
        page = cover.new_page()
        page.insert_text((60, 90), f"Catalog number: {catalog_number}", fontsize=22)
        page.insert_text((60, 150), "Original signature (redacted on this copy):", fontsize=22)
        page.draw_rect((60, 180, 430, 220), color=(0, 0, 0), fill=(0, 0, 0))
        pixels = page.get_pixmap(dpi=180)
        paper.delete_page(0)
        scan = paper.new_page(pno=0, width=page.rect.width, height=page.rect.height)
        scan.insert_image(scan.rect, pixmap=pixels)
        return paper.tobytes(deflate=True)


if __name__ == "__main__":
    sys.stdout.buffer.write(scanned_cover(sys.argv[1], sys.argv[2]))
