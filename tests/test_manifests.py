import shutil
from pathlib import Path

import pytest
from pydantic import ValidationError

from pdfbucket.extraction import plugin_arguments
from pdfbucket.manifest import PluginManifest, load_manifest

MANIFESTS = Path(__file__).resolve().parents[1] / "plugins" / "manifests"


def test_shipped_manifests_load_and_carry_only_declared_plugins() -> None:
    extractions = load_manifest(MANIFESTS / "extractions.json")
    resolvers = load_manifest(MANIFESTS / "resolvers.json")

    assert [plugin.id for plugin in extractions.plugins] == ["mineru-flash", "mineru-precise", "mistral-ocr"]
    assert [plugin.id for plugin in resolvers.plugins] == ["doi", "isbn", "arxiv", "zbmath"]


def test_every_shipped_extraction_command_resolves_and_receives_the_pdf_and_its_output_directory(tmp_path: Path) -> None:
    pdf = tmp_path / "lattices.pdf"
    output = tmp_path / "staging" / "output"

    for plugin in load_manifest(MANIFESTS / "extractions.json").plugins:
        arguments = plugin_arguments(plugin, pdf, output)
        assert shutil.which(arguments[0]) is not None, plugin.id
        assert str(pdf) in arguments, plugin.id
        assert str(output) in arguments or f"{output}/extraction.md" in arguments, plugin.id


def test_manifest_rejects_a_plugin_with_an_undeclared_field() -> None:
    with pytest.raises(ValidationError):
        PluginManifest.model_validate(
            {
                "plugins": [
                    {
                        "id": "doi",
                        "name": "DOI Resolver",
                        "command": ["node", "resolvers/doi.mjs"],
                        "accepted_inputs": [],
                        "timeout_ms": 5000,
                    }
                ]
            }
        )


def test_manifest_rejects_a_plugin_without_a_command() -> None:
    with pytest.raises(ValidationError):
        PluginManifest.model_validate({"plugins": [{"id": "doi", "name": "DOI Resolver", "command": [], "accepted_inputs": []}]})


def test_manifest_rejects_a_pdf_limit_of_an_undeclared_kind() -> None:
    with pytest.raises(ValidationError):
        PluginManifest.model_validate(
            {
                "plugins": [
                    {
                        "id": "flash",
                        "name": "Flash",
                        "command": ["flash", "$pdf", "$output"],
                        "accepted_inputs": [{"kind": "pdf", "id": "pdf", "label": "PDF", "limits": [{"kind": "max_minutes", "value": 5}]}],
                    }
                ]
            }
        )
