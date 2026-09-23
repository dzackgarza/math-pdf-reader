from pathlib import Path

import pytest
from pydantic import ValidationError

from pdfbucket_plugins.manifest import PluginManifest, load_manifest

MANIFESTS = Path(__file__).resolve().parents[1] / "plugins" / "manifests"


def test_shipped_manifests_load_and_carry_only_declared_plugins() -> None:
    extractions = load_manifest(MANIFESTS / "extractions.json")
    resolvers = load_manifest(MANIFESTS / "resolvers.json")

    assert [plugin.id for plugin in extractions.plugins] == []
    assert [plugin.id for plugin in resolvers.plugins] == []


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
        PluginManifest.model_validate(
            {"plugins": [{"id": "doi", "name": "DOI Resolver", "command": [], "accepted_inputs": []}]}
        )
