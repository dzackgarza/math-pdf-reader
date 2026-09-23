from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path

import pytest
from pydantic import HttpUrl

from pdfbucket.cli import app
from pdfbucket.extraction import ExtractionFailed, ExtractionRejected, ExtractionSucceeded, LimitViolation, run_extraction
from pdfbucket.manifest import MaxBytes, MaxPages, PluginCommand, PluginManifest
from pdfbucket.models import CaptureRequest
from pdfbucket.store import store_pdf

FIXTURES = Path(__file__).resolve().parent / "fixtures"
TEN_PAGES = FIXTURES / "ten-page-notes.pdf"
EXTRACTOR = FIXTURES / "plugins" / "extractor.sh"
KEY = "integral lattices"


def stored_root(tmp_path: Path) -> Path:
    request = CaptureRequest(
        pdf_url=HttpUrl("https://www.math.example.edu/~author/lattices.pdf"),
        source_url=HttpUrl("https://www.math.example.edu/~author/teaching.html"),
        title_hint="Ten Lectures on Integral Lattices",
    )
    store_pdf(tmp_path, TEN_PAGES.read_bytes(), request, f"{KEY}.pdf", datetime.now(UTC))
    return tmp_path


def extractor(mode: str, limits: list[dict[str, str | int]]) -> PluginCommand:
    manifest = PluginManifest.model_validate(
        {
            "plugins": [
                {
                    "id": f"fixture-{mode}",
                    "name": f"Fixture extractor ({mode})",
                    "command": ["sh", str(EXTRACTOR), mode, "$pdf", "$output"],
                    "accepted_inputs": [{"kind": "pdf", "id": "pdf", "label": "PDF", "limits": limits}],
                }
            ]
        }
    )
    return manifest.plugins[0]


def digest(path: Path) -> str:
    return sha256(path.read_bytes()).hexdigest()


def test_a_run_passes_the_stored_pdf_and_a_staging_directory_and_places_markdown_and_artifacts_beside_the_pdf(tmp_path: Path) -> None:
    root = stored_root(tmp_path)
    pdf = root / f"{KEY}.pdf"

    outcome = run_extraction(root, KEY, extractor("record", []))

    assert isinstance(outcome, ExtractionSucceeded)
    mode, pdf_argument, output_argument = (root / f"{KEY}.md").read_text().splitlines()
    assert (mode, pdf_argument) == ("record", str(pdf))
    staging = Path(output_argument)
    assert staging.parent.parent == root
    assert staging.parent.name.startswith(".extracting-")
    assert not staging.parent.exists()
    assert sorted(p.name for p in root.iterdir()) == [f"{KEY}.extraction", f"{KEY}.md", f"{KEY}.pdf"]
    assert digest(root / f"{KEY}.extraction" / "source.pdf") == digest(pdf)
    assert outcome.markdown.path == f"{KEY}.md"
    assert outcome.markdown.sha256 == digest(root / f"{KEY}.md")
    assert [(a.path, a.sha256, a.size) for a in outcome.artifacts] == [(f"{KEY}.extraction/source.pdf", digest(pdf), pdf.stat().st_size)]


def test_a_later_run_replaces_the_whole_previous_extraction(tmp_path: Path) -> None:
    root = stored_root(tmp_path)
    run_extraction(root, KEY, extractor("record", []))

    outcome = run_extraction(root, KEY, extractor("markdown", []))

    assert isinstance(outcome, ExtractionSucceeded)
    assert (root / f"{KEY}.md").read_text() == "# Extracted by the markdown mode\n"
    assert outcome.artifacts == []
    assert sorted(p.name for p in root.iterdir()) == [f"{KEY}.md", f"{KEY}.pdf"]


def test_a_failing_plugin_returns_its_exit_code_and_stderr_and_leaves_the_root_untouched(tmp_path: Path) -> None:
    root = stored_root(tmp_path)
    run_extraction(root, KEY, extractor("record", []))
    before = {p.name: digest(p) for p in root.rglob("*") if p.is_file()}

    outcome = run_extraction(root, KEY, extractor("fail", []))

    assert outcome == ExtractionFailed(key=KEY, plugin_id="fixture-fail", exit_code=3, stderr="provider quota exhausted for this token\n")
    assert {p.name: digest(p) for p in root.rglob("*") if p.is_file()} == before
    assert sorted(p.name for p in root.iterdir()) == [f"{KEY}.extraction", f"{KEY}.md", f"{KEY}.pdf"]


def test_a_plugin_that_writes_its_markdown_under_another_name_places_nothing(tmp_path: Path) -> None:
    root = stored_root(tmp_path)

    with pytest.raises(AssertionError):
        run_extraction(root, KEY, extractor("misnamed", []))

    assert [p.name for p in root.iterdir()] == [f"{KEY}.pdf"]


def test_a_pdf_outside_the_accepted_limits_is_rejected_before_the_plugin_runs(tmp_path: Path) -> None:
    root = stored_root(tmp_path)
    size = (root / f"{KEY}.pdf").stat().st_size
    plugin = extractor("record", [{"kind": "max_pages", "value": 5}, {"kind": "max_bytes", "value": size}])

    outcome = run_extraction(root, KEY, plugin)

    assert outcome == ExtractionRejected(
        key=KEY,
        plugin_id="fixture-record",
        violations=[LimitViolation(limit=MaxPages(kind="max_pages", value=5), observed=10)],
    )
    assert [p.name for p in root.iterdir()] == [f"{KEY}.pdf"]

    too_small = extractor("record", [{"kind": "max_bytes", "value": size - 1}])
    assert run_extraction(root, KEY, too_small) == ExtractionRejected(
        key=KEY,
        plugin_id="fixture-record",
        violations=[LimitViolation(limit=MaxBytes(kind="max_bytes", value=size - 1), observed=size)],
    )


def test_the_extract_command_runs_a_plugin_named_in_a_manifest_file_and_prints_the_outcome(capsys: pytest.CaptureFixture[str], tmp_path: Path) -> None:
    (tmp_path / "root").mkdir()
    root = stored_root(tmp_path / "root")
    manifest = tmp_path / "extractions.json"
    manifest.write_text(PluginManifest(plugins=[extractor("markdown", []), extractor("record", [])]).model_dump_json())

    app(["extract", str(root), KEY, str(manifest), "fixture-record"], result_action="return_value")

    outcome = ExtractionSucceeded.model_validate_json(capsys.readouterr().out)
    assert outcome.plugin_id == "fixture-record"
    assert (root / f"{KEY}.md").read_text().splitlines()[0] == "record"
    assert [artifact.path for artifact in outcome.artifacts] == [f"{KEY}.extraction/source.pdf"]
