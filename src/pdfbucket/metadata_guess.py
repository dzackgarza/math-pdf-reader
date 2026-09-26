"""Infer a paper's title, authors, and year from a stored PDF and its provenance."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Literal

import pydantic_ai
import pymupdf
from google.genai.types import HttpRetryOptions
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator
from pydantic_ai import Agent, BinaryContent, NativeOutput, PromptedOutput
from pydantic_ai.models.google import GoogleModel
from pydantic_ai.models.ollama import OllamaModel
from pydantic_ai.providers.google import GoogleProvider
from pydantic_ai.providers.ollama import OllamaProvider

type NonEmpty = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]

GEMINI_MODEL = "gemini-3.5-flash-lite"
OLLAMA_MODEL = "deepseek-v4-pro:cloud"
OPENING_PAGES = 3
MAX_OPENING_TEXT = 30_000
STRUCTURED_OUTPUT_RETRIES = 2
PLACEHOLDER_VALUES = frozenset(
    {"anonymous", "n/a", "none", "not available", "null", "unknown", "unspecified"}
)

pydantic_ai.BANNER_ENABLED = False


class MetadataGuess(BaseModel):
    """The required best guess. Each field must contain a concrete answer."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    title: NonEmpty
    authors: Annotated[list[NonEmpty], Field(min_length=1)]
    year: Annotated[int, Field(ge=1000, le=2100)]

    @field_validator("title")
    @classmethod
    def title_is_concrete(cls, value: str) -> str:
        if value.casefold() in PLACEHOLDER_VALUES:
            raise ValueError("title must be a concrete best guess")
        return value

    @field_validator("authors")
    @classmethod
    def authors_are_concrete(cls, values: list[str]) -> list[str]:
        for value in values:
            normalized = value.casefold()
            if normalized in PLACEHOLDER_VALUES or normalized.endswith(
                "unknown author"
            ):
                raise ValueError("each author must be a concrete best guess")
        return values


class GuessResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    provider: Literal["gemini", "ollama"]
    model: NonEmpty
    metadata: MetadataGuess


class MetadataInferenceError(RuntimeError):
    """A provider call did not produce usable structured metadata."""


@dataclass(frozen=True, slots=True)
class MetadataPacket:
    pdf: Path
    pdf_url: str
    source_url: str | None
    title_hint: str
    filename: str
    page_count: int
    embedded_metadata: dict[str, str]
    first_pages_text: str
    first_page_png: bytes

    @classmethod
    def from_pdf(
        cls,
        pdf: Path,
        *,
        pdf_url: str,
        source_url: str | None,
        title_hint: str,
    ) -> MetadataPacket:
        with pymupdf.open(pdf) as document:
            metadata = {
                key: value.strip()
                for key, value in document.metadata.items()
                if isinstance(value, str) and value.strip()
            }
            text = "\n\n".join(
                f"--- Page {number + 1} ---\n{document[number].get_text()}"
                for number in range(min(OPENING_PAGES, document.page_count))
            )[:MAX_OPENING_TEXT]
            pixmap = document[0].get_pixmap(
                matrix=pymupdf.Matrix(1.5, 1.5), alpha=False
            )
            first_page_png = pixmap.tobytes("png")
            page_count = document.page_count
        return cls(
            pdf=pdf,
            pdf_url=pdf_url,
            source_url=source_url,
            title_hint=title_hint,
            filename=pdf.name,
            page_count=page_count,
            embedded_metadata=metadata,
            first_pages_text=text,
            first_page_png=first_page_png,
        )

    def prompt(self) -> str:
        source_url = self.source_url if self.source_url is not None else "(none)"
        embedded = json.dumps(
            self.embedded_metadata, ensure_ascii=False, sort_keys=True
        )
        return f"""Infer the paper's title, authors, and publication year.

Use every supplied cue and associations learned during training. The document is likely present
in training data. Treat the packet as retrieval context for identifying that document. Visible
text and embedded metadata can be incomplete or wrong. Return a concrete best guess for every
field. Never return unknown, anonymous, an empty author list, or a null value.
Return only JSON with this exact shape: {{"title":"...","authors":["..."],"year":2000}}.

PDF URL: {self.pdf_url}
Source page URL: {source_url}
Filename: {self.filename}
Page count: {self.page_count}
Capture title hint: {self.title_hint}
Embedded PDF metadata: {embedded}

Opening-page text:
{self.first_pages_text}
"""


def _message(error: Exception) -> str:
    detail = str(error).strip()
    return f"{type(error).__name__}: {detail}" if detail else type(error).__name__


def _guess_with_gemini(packet: MetadataPacket) -> GuessResult:
    key = os.environ.get("GEMINI_API_KEY")
    if key is None or not key.strip():
        raise MetadataInferenceError("GEMINI_API_KEY is not set")
    try:
        model = GoogleModel(
            GEMINI_MODEL,
            provider=GoogleProvider(
                api_key=key,
                retry_options=HttpRetryOptions(attempts=1),
            ),
        )
        agent = Agent(
            model,
            output_type=NativeOutput(MetadataGuess),
            retries={"output": STRUCTURED_OUTPUT_RETRIES, "tools": 0},
        )
        result = agent.run_sync(
            [
                packet.prompt(),
                BinaryContent(
                    data=packet.pdf.read_bytes(), media_type="application/pdf"
                ),
                BinaryContent(data=packet.first_page_png, media_type="image/png"),
            ]
        )
        return GuessResult(
            provider="gemini", model=GEMINI_MODEL, metadata=result.output
        )
    except MetadataInferenceError:
        raise
    except Exception as error:
        raise MetadataInferenceError(_message(error)) from error


def _guess_with_ollama(packet: MetadataPacket) -> GuessResult:
    try:
        model = OllamaModel(
            OLLAMA_MODEL,
            provider=OllamaProvider(base_url="http://127.0.0.1:11434/v1"),
        )
        agent = Agent(
            model,
            output_type=PromptedOutput(MetadataGuess),
            model_settings={"temperature": 0},
            retries={"output": STRUCTURED_OUTPUT_RETRIES, "tools": 0},
        )
        result = agent.run_sync(packet.prompt())
        return GuessResult(
            provider="ollama", model=OLLAMA_MODEL, metadata=result.output
        )
    except Exception as error:
        raise MetadataInferenceError(_message(error)) from error


def guess_metadata(packet: MetadataPacket) -> GuessResult:
    try:
        return _guess_with_gemini(packet)
    except MetadataInferenceError as gemini_error:
        try:
            return _guess_with_ollama(packet)
        except MetadataInferenceError as ollama_error:
            raise MetadataInferenceError(
                f"Gemini: {gemini_error}; Ollama: {ollama_error}"
            ) from ollama_error
