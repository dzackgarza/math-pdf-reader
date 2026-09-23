"""Plugin manifest contract.


A plugin is an external command plus the inputs it accepts. Extraction plugins and
resolver plugins share this manifest shape.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, PositiveInt


class IdentifierInput(BaseModel):
    """A resolver input: an identifier string the pattern matches."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["identifier"]
    id: str
    label: str
    example: str
    pattern: str


class MaxPages(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: Literal["max_pages"]
    value: PositiveInt


class MaxBytes(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: Literal["max_bytes"]
    value: PositiveInt


type PdfLimit = Annotated[MaxPages | MaxBytes, Field(discriminator="kind")]


class PdfInput(BaseModel):
    """An extraction input: a PDF within every listed limit; no limits means any PDF."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["pdf"]
    id: str
    label: str
    limits: list[PdfLimit]


type AcceptedInput = Annotated[IdentifierInput | PdfInput, Field(discriminator="kind")]


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
