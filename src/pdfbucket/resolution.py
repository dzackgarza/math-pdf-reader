"""Resolver runner: find an identifier for a stored PDF and turn it into BibTeX with a plugin.

The candidates, in order, are the PDF's source URL and PDF URL from its provenance, then the
identifiers the publisher embedded in the file: arXiv's generated PDFs carry `/arXivID` and
`/DOI` in the document information dictionary, and publishers following PRISM carry
`prism:doi` and `prism:isbn` in XMP. The first candidate that a manifest plugin's identifier pattern accepts
is resolved by that plugin. Plugin contract: the identifier on stdin, one BibTeX entry on
stdout; the command runs in the manifest's directory, so relative paths in it resolve there.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Literal

import pikepdf
from pydantic import BaseModel, ConfigDict

from pdfbucket.manifest import IdentifierInput, PluginCommand, PluginManifest
from pdfbucket.provenance import read_stored_item
from pdfbucket.store import pdf_path

DOCINFO_IDENTIFIER_KEYS = ("/arXivID", "/DOI")
PRISM = "http://prismstandard.org/namespaces/basic/2.0/"
PRISM_IDENTIFIER_KEYS = (f"{{{PRISM}}}doi", f"{{{PRISM}}}isbn")


class ResolverInput(BaseModel):
    """A candidate identifier and the plugin whose pattern accepts it."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    plugin: PluginCommand
    identifier: str


class Resolved(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    status: Literal["resolved"] = "resolved"
    key: str
    plugin_id: str
    identifier: str
    bibtex: str


class Unidentified(BaseModel):
    """No candidate matches any plugin: the item has no identifier the resolvers know."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    status: Literal["unidentified"] = "unidentified"
    key: str
    candidates: list[str]


class ResolverFailed(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    status: Literal["failed"] = "failed"
    key: str
    plugin_id: str
    identifier: str
    exit_code: int
    stderr: str


def identifier_candidates(pdf: Path) -> list[str]:
    provenance = read_stored_item(pdf).provenance
    with pikepdf.open(pdf) as document:
        docinfo = {str(key): str(value) for key, value in document.docinfo.items()}
        embedded = [docinfo[key] for key in DOCINFO_IDENTIFIER_KEYS if key in docinfo]
        with document.open_metadata(set_pikepdf_as_editor=False) as xmp:
            embedded.extend(str(xmp[key]) for key in PRISM_IDENTIFIER_KEYS if key in xmp)
    urls = [str(provenance.source_url), str(provenance.pdf_url)]
    return list(dict.fromkeys(candidate.strip() for candidate in [*urls, *embedded]))


def accepts(accepted: IdentifierInput, candidate: str) -> bool:
    return re.match(accepted.pattern, candidate, re.IGNORECASE) is not None


def resolver_inputs(manifest: PluginManifest, candidates: list[str]) -> list[ResolverInput]:
    """Every (plugin, candidate) pair a pattern accepts: candidates in order, plugins in manifest order."""
    return [
        ResolverInput(plugin=plugin, identifier=candidate)
        for candidate in candidates
        for plugin in manifest.plugins
        if any(isinstance(accepted, IdentifierInput) and accepts(accepted, candidate) for accepted in plugin.accepted_inputs)
    ]


def resolve(root: Path, key: str, manifest: PluginManifest, manifest_dir: Path) -> Resolved | Unidentified | ResolverFailed:
    candidates = identifier_candidates(pdf_path(root, key))
    matches = resolver_inputs(manifest, candidates)
    if not matches:
        return Unidentified(key=key, candidates=candidates)

    chosen = matches[0]
    completed = subprocess.run(
        chosen.plugin.command,
        input=chosen.identifier,
        cwd=manifest_dir,
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        return ResolverFailed(
            key=key,
            plugin_id=chosen.plugin.id,
            identifier=chosen.identifier,
            exit_code=completed.returncode,
            stderr=completed.stderr,
        )
    bibtex = completed.stdout.strip()
    assert bibtex.startswith("@"), f"resolver {chosen.plugin.id} printed no BibTeX entry: {bibtex[:200]!r}"
    return Resolved(key=key, plugin_id=chosen.plugin.id, identifier=chosen.identifier, bibtex=bibtex)
