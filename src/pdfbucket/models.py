"""The documents the pikepdf commands read and print, matching src/contract/store.ts."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import (
    AfterValidator,
    AnyUrl,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
)

type NonEmpty = Annotated[str, StringConstraints(min_length=1)]
type Sha256 = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]


def _url(text: str) -> str:
    AnyUrl(text)
    return text


def _timestamp(text: str) -> str:
    if datetime.fromisoformat(text).tzinfo is None:
        raise ValueError(f"{text} carries no UTC offset")
    return text


# A URL or timestamp is checked and kept as the exact text given: provenance is embedded and
# read back byte for byte, never normalized.
type Url = Annotated[str, AfterValidator(_url)]
type Timestamp = Annotated[str, AfterValidator(_timestamp)]


class Provenance(BaseModel):
    """What every stored PDF carries inside the file. `source_url` is absent when no linking page is known."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    pdf_url: Url
    source_url: Url | None
    captured_at: Timestamp
    original_sha256: Sha256
    title_hint: NonEmpty


# Where an item's title came from: a manual edit, a resolver, an inference, the PDF,
# the capture hint, or the file name.
type TitleSource = Literal["manual", "resolver", "guess", "pdf-metadata", "capture-hint", "filename"]


class ItemTitle(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    text: NonEmpty
    source: TitleSource


class PdfRecord(BaseModel):
    """What a stored PDF says about itself, read from the file alone."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    provenance: Provenance
    title: ItemTitle
    authors: list[NonEmpty]
    # Recorded from a resolver; None when none gave them.
    year: int | None
    abstract: NonEmpty | None
    pages: Annotated[int, Field(ge=1)]


class Read(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    status: Literal["read"] = "read"
    record: PdfRecord


class Unreadable(BaseModel):
    """A file pikepdf cannot open, or one without the bucket's provenance."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    status: Literal["unreadable"] = "unreadable"
    message: NonEmpty


type ReadOutcome = Annotated[Read | Unreadable, Field(discriminator="status")]


class StoreFailure(BaseModel):
    """Why a command on one PDF could not do its work; printed with exit status 3."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: Literal["unreadable_pdf", "missing_provenance", "invalid_metadata"]
    message: NonEmpty
