import json
from pathlib import Path

import pikepdf

from pdfbucket_extractors.mineru_precise import ChunkResult, ContentList, Layout, joined, pages_per_chunk
from pdfbucket_extractors.pages import page_ranges, split_pdf

FIXTURES = Path(__file__).resolve().parent / "fixtures"
MINERU = FIXTURES / "mineru-ten-page-notes"


def mineru_result() -> ChunkResult:
    return ChunkResult(
        markdown=(MINERU / "full.md").read_text(),
        content_list=ContentList.validate_json((MINERU / "content_list.json").read_bytes()),
        layout=Layout.model_validate_json((MINERU / "layout.json").read_bytes()),
    )


def test_a_long_pdf_splits_into_chunks_of_the_same_pages_in_order(tmp_path: Path) -> None:
    source_pdf = FIXTURES / "long-notes.pdf"

    chunks = split_pdf(source_pdf, page_ranges(210, 200), tmp_path)

    assert [path.name for path in chunks] == ["pages-0001-0200.pdf", "pages-0201-0210.pdf"]
    with pikepdf.open(source_pdf) as source, pikepdf.open(chunks[0]) as first, pikepdf.open(chunks[1]) as second:
        assert (len(first.pages), len(second.pages)) == (200, 10)
        assert second.pages[0].Contents.read_bytes() == source.pages[200].Contents.read_bytes()
        assert first.pages[199].Contents.read_bytes() == source.pages[199].Contents.read_bytes()


def test_chunk_size_is_bounded_by_the_page_limit_and_by_the_upload_byte_budget() -> None:
    # A text-only 210-page PDF of 116 KB is bounded by MinerU's 200-page limit.
    assert pages_per_chunk(116_176, 210) == 200
    # A 200-page scan of 16 MB (80 KB a page) is bounded by the 4 MiB upload budget.
    assert pages_per_chunk(16_000_000, 200) == 52
    # A single page larger than the budget still goes alone.
    assert pages_per_chunk(9_000_000, 1) == 1


def test_joined_chunks_shift_page_indexes_back_to_the_whole_document_and_keep_mineru_fields() -> None:
    chunk = mineru_result()

    whole = joined([(0, 10, chunk), (10, 20, chunk)])

    raw_blocks = json.loads((MINERU / "content_list.json").read_text())
    dumped_blocks = json.loads(ContentList.dump_json(whole.content_list))
    assert dumped_blocks == raw_blocks + [{**block, "page_idx": block["page_idx"] + 10} for block in raw_blocks]
    assert [page.page_idx for page in whole.layout.pdf_info] == list(range(20))
    raw_layout = json.loads((MINERU / "layout.json").read_text())
    dumped_layout = json.loads(whole.layout.model_dump_json())
    assert {key: value for key, value in dumped_layout.items() if key != "pdf_info"} == {key: value for key, value in raw_layout.items() if key != "pdf_info"}
    assert dumped_layout["pdf_info"][13] == {**raw_layout["pdf_info"][3], "page_idx": 13}
    assert whole.markdown == f"<!-- pages 1-10 -->\n\n{chunk.markdown}\n\n<!-- pages 11-20 -->\n\n{chunk.markdown}"
