"""Extraction runner: run a manifest plugin on a stored PDF, place its artifacts beside it.

Plugin contract: `$pdf` and `$output` in the command are replaced by the stored PDF and an
empty output directory. On exit 0 the plugin has written `$output/extraction.md` and, when
it has more, files under `$output/artifacts/`; the runner moves them to `<root>/<key>.md`
and `<root>/<key>.extraction/`, replacing the previous extraction. The output directory is
staged inside the root and removed afterwards, so a plugin that exits non-zero places
nothing.
"""

from __future__ import annotations

import subprocess
from hashlib import sha256
from pathlib import Path
from string import Template
from tempfile import TemporaryDirectory
from typing import Literal

import pikepdf
from pydantic import BaseModel, ConfigDict

from pdfbucket.manifest import PdfInput, PdfLimit, PluginCommand, PluginManifest
from pdfbucket.store import pdf_path

MARKDOWN = "extraction.md"
ARTIFACTS = "artifacts"


class UnknownPluginError(LookupError):
    """A plugin id the manifest does not list."""


class ArtifactFile(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    path: str
    sha256: str
    size: int


class LimitViolation(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    limit: PdfLimit
    observed: int


class ExtractionSucceeded(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    status: Literal["succeeded"] = "succeeded"
    key: str
    plugin_id: str
    markdown: ArtifactFile
    artifacts: list[ArtifactFile]


class ExtractionFailed(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    status: Literal["failed"] = "failed"
    key: str
    plugin_id: str
    exit_code: int
    stderr: str


class ExtractionRejected(BaseModel):
    """The PDF is outside the plugin's accepted input; the plugin did not run."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    status: Literal["rejected"] = "rejected"
    key: str
    plugin_id: str
    violations: list[LimitViolation]


def plugin_by_id(manifest: PluginManifest, plugin_id: str) -> PluginCommand:
    for plugin in manifest.plugins:
        if plugin.id == plugin_id:
            return plugin
    raise UnknownPluginError(plugin_id)


def plugin_arguments(plugin: PluginCommand, pdf: Path, output: Path) -> list[str]:
    return [Template(argument).substitute(pdf=str(pdf), output=str(output)) for argument in plugin.command]


def limit_violations(plugin: PluginCommand, pdf: Path) -> list[LimitViolation]:
    inputs = [accepted for accepted in plugin.accepted_inputs if isinstance(accepted, PdfInput)]
    assert inputs, f"plugin {plugin.id} accepts no PDF input"
    with pikepdf.open(pdf) as document:
        measured = {"max_pages": len(document.pages), "max_bytes": pdf.stat().st_size}
    return [LimitViolation(limit=limit, observed=measured[limit.kind]) for accepted in inputs for limit in accepted.limits if measured[limit.kind] > limit.value]


def artifact_file(root: Path, path: Path) -> ArtifactFile:
    data = path.read_bytes()
    return ArtifactFile(path=path.relative_to(root).as_posix(), sha256=sha256(data).hexdigest(), size=len(data))


def place_artifacts(root: Path, key: str, plugin_id: str, output: Path, staging: Path) -> ExtractionSucceeded:
    produced = {path.name for path in output.iterdir()}
    assert MARKDOWN in produced and produced <= {MARKDOWN, ARTIFACTS}, f"plugin {plugin_id} wrote {sorted(produced)}, not {MARKDOWN} and {ARTIFACTS}/"
    assert (output / MARKDOWN).read_text(encoding="utf-8").strip(), f"plugin {plugin_id} wrote an empty {MARKDOWN}"

    markdown = root / f"{key}.md"
    extraction_dir = root / f"{key}.extraction"
    if extraction_dir.exists():
        extraction_dir.replace(staging / "replaced")
    if ARTIFACTS in produced:
        (output / ARTIFACTS).replace(extraction_dir)
    # The Markdown lands last: its presence marks a complete extraction.
    (output / MARKDOWN).replace(markdown)

    return ExtractionSucceeded(
        key=key,
        plugin_id=plugin_id,
        markdown=artifact_file(root, markdown),
        artifacts=[artifact_file(root, path) for path in sorted(extraction_dir.rglob("*")) if path.is_file()],
    )


def run_extraction(root: Path, key: str, plugin: PluginCommand) -> ExtractionSucceeded | ExtractionFailed | ExtractionRejected:
    pdf = pdf_path(root, key)
    violations = limit_violations(plugin, pdf)
    if violations:
        return ExtractionRejected(key=key, plugin_id=plugin.id, violations=violations)

    with TemporaryDirectory(dir=root, prefix=".extracting-") as staging_dir:
        staging = Path(staging_dir)
        output = staging / "output"
        output.mkdir()
        completed = subprocess.run(
            plugin_arguments(plugin, pdf, output),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            check=False,
        )
        if completed.returncode != 0:
            return ExtractionFailed(key=key, plugin_id=plugin.id, exit_code=completed.returncode, stderr=completed.stderr)
        return place_artifacts(root, key, plugin.id, output, staging)
