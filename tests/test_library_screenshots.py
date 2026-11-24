"""Regression coverage for the library screenshot workflow's real bucket setup."""

import importlib.util
from contextlib import ExitStack
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "library_screenshots", REPO / "scripts/library_screenshots.py"
)
assert SPEC is not None and SPEC.loader is not None
screenshots = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(screenshots)


def test_seeded_extraction_is_visible_after_the_bucket_starts(tmp_path: Path) -> None:
    """The state the inspector-extraction screenshot waits for is present in the library API."""
    root = tmp_path / "bucket"
    root.mkdir()
    key = "ten-page-notes"
    screenshots.capture_fixture(
        root,
        "ten-page-notes.pdf",
        key,
        "https://www.math.example.edu/~author/ten-page-notes.pdf",
        "Ten Lectures on Integral Lattices",
    )
    with ExitStack() as stack:
        origin = screenshots.serve(
            stack, root, screenshots.closed_port_url(), screenshots.SHIPPED_EXTRACTIONS
        )
        screenshots.place_extraction(root, key)

        payload = screenshots.call(origin, "GET", "/api/library")

        items = payload["items"]
        assert isinstance(items, list) and len(items) == 1
        item = items[0]
        assert isinstance(item, dict)
        extraction = item["extraction"]
        assert isinstance(extraction, dict)
        assert extraction["status"] == "extracted", extraction
        assert (root / key / "ten-page-notes.md").is_file()
        assert (
            root / key / "ten-page-notes.extraction" / "content_list.json"
        ).is_file()
        assert not (root / "ten-page-notes.md").exists()
        assert not (root / "ten-page-notes.extraction").exists()
