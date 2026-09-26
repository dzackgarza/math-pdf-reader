from pathlib import Path

import pytest

from pdfbucket.metadata_guess import (
    GuessFailure,
    GuessResult,
    MetadataGuess,
    MetadataPacket,
    guess_metadata,
)


FIXTURES = Path(__file__).parent / "fixtures"


def packet() -> MetadataPacket:
    return MetadataPacket.from_pdf(
        FIXTURES / "lecture-notes.pdf",
        pdf_url="https://example.org/papers/lecture-notes.pdf",
        source_url="https://example.org/papers",
        title_hint="Download PDF",
    )


def test_metadata_packet_contains_the_document_cues() -> None:
    built = packet()

    assert built.filename == "lecture-notes.pdf"
    assert built.page_count > 0
    assert built.first_pages_text.strip()
    assert built.first_page_png.startswith(b"\x89PNG\r\n\x1a\n")
    assert built.pdf_url == "https://example.org/papers/lecture-notes.pdf"
    assert built.source_url == "https://example.org/papers"
    assert built.title_hint == "Download PDF"


def test_invalid_gemini_answer_uses_ollama_once(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    def gemini(_: MetadataPacket) -> GuessResult:
        calls.append("gemini")
        raise GuessFailure("Gemini returned no authors")

    def ollama(_: MetadataPacket) -> GuessResult:
        calls.append("ollama")
        return GuessResult(
            provider="ollama",
            model="deepseek-v4-pro:cloud",
            metadata=MetadataGuess(
                title="Lectures on integral lattices",
                authors=["Jacques Martinet"],
                year=2003,
            ),
        )

    monkeypatch.setattr("pdfbucket.metadata_guess._guess_with_gemini", gemini)
    monkeypatch.setattr("pdfbucket.metadata_guess._guess_with_ollama", ollama)

    result = guess_metadata(packet())

    assert calls == ["gemini", "ollama"]
    assert result.provider == "ollama"
    assert result.metadata.authors == ["Jacques Martinet"]


def test_both_provider_failures_are_reported(monkeypatch: pytest.MonkeyPatch) -> None:
    def gemini(_: MetadataPacket) -> GuessResult:
        raise GuessFailure("Gemini quota exhausted")

    def ollama(_: MetadataPacket) -> GuessResult:
        raise GuessFailure("Ollama model unavailable")

    monkeypatch.setattr("pdfbucket.metadata_guess._guess_with_gemini", gemini)
    monkeypatch.setattr("pdfbucket.metadata_guess._guess_with_ollama", ollama)

    with pytest.raises(
        GuessFailure,
        match="Gemini: Gemini quota exhausted; Ollama: Ollama model unavailable",
    ):
        guess_metadata(packet())
