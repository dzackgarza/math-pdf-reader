"""Capture and store contracts shared by the CLI and the server."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import AnyUrl, AwareDatetime, BaseModel, ConfigDict, Field, TypeAdapter, UrlConstraints

# Where a PDF came from: a web page and PDF URL for a browser capture or a URL import, a
# `file:` URL for a PDF added from a folder on this computer.
type SourceUrl = Annotated[AnyUrl, UrlConstraints(allowed_schemes=["http", "https", "file"], host_required=False)]

SOURCE_URL: TypeAdapter[SourceUrl] = TypeAdapter(SourceUrl)


class CaptureRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    pdf_url: SourceUrl
    source_url: SourceUrl
    title_hint: str


class CaptureProvenance(BaseModel):
    """What every stored PDF carries inside the file."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    pdf_url: SourceUrl
    source_url: SourceUrl
    captured_at: AwareDatetime
    original_sha256: str
    title_hint: str


# Where an item's title came from, best first: an identifier resolver, the PDF's own metadata,
# the title the capture offered (link text, page title), the stored file's name.
type TitleSource = Literal["resolver", "pdf-metadata", "capture-hint", "filename"]


class ItemTitle(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    text: str = Field(min_length=1)
    source: TitleSource


class StoredItem(BaseModel):
    """A stored PDF as read back from the file alone."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    key: str
    provenance: CaptureProvenance
    title: ItemTitle
    authors: list[str]


class CaptureResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    item: StoredItem
    stored_sha256: str
    existing: bool


def provenance_for(request: CaptureRequest, captured_at: datetime, original_sha256: str) -> CaptureProvenance:
    return CaptureProvenance(
        pdf_url=request.pdf_url,
        source_url=request.source_url,
        captured_at=captured_at,
        original_sha256=original_sha256,
        title_hint=request.title_hint,
    )
