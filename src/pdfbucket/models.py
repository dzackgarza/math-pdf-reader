"""Capture and store contracts shared by the CLI and the server."""

from __future__ import annotations

from datetime import datetime

from pydantic import AwareDatetime, BaseModel, ConfigDict, HttpUrl


class CaptureRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    pdf_url: HttpUrl
    source_url: HttpUrl
    title_hint: str


class CaptureProvenance(BaseModel):
    """What every stored PDF carries inside the file."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    pdf_url: HttpUrl
    source_url: HttpUrl
    captured_at: AwareDatetime
    original_sha256: str
    title_hint: str


class StoredItem(BaseModel):
    """A stored PDF as read back from the file alone."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    key: str
    provenance: CaptureProvenance


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
