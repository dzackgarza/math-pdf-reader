"""Plugin manifest contract.

Shape cribbed from zotero-gui (resolver-plugins.json, src/server/resolverPlugins.ts):
a plugin is an external command plus the inputs it accepts. Extraction plugins and
resolver plugins share this manifest shape.
"""

from __future__ import annotations

import json
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field


class AcceptedInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    label: str
    example: str
    pattern: str


class PluginCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    name: str
    command: list[str] = Field(min_length=1)
    accepted_inputs: list[AcceptedInput]


class PluginManifest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    plugins: list[PluginCommand]


def load_manifest(path: Path) -> PluginManifest:
    return PluginManifest.model_validate(json.loads(path.read_text()))
