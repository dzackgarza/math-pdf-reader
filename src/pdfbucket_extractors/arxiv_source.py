"""arXiv source extraction: the paper's LaTeX source, flattened and converted to Markdown.

The arXiv id comes from the PDF URL embedded in the stored PDF. The source package (`/e-print/<id>`)
is a tar archive, or one gzipped `.tex` file. Its main file is the one with `\\documentclass`
that no other file pulls in. `latexpand` (texlive-extra-utils) inlines every `\\input`/`\\include`
and the `.bbl` bibliography and drops comments, so a paper strewn across many files is one
document; `pandoc` reads it, applies the paper's own macros, and writes Markdown with citations
as `[@key]` and `$...$` math. LaTeX that pandoc cannot interpret is dropped, not passed through
as raw TeX, which keeps the Markdown readable. The flattened source stays in
`artifacts/source.tex`. A paper without a source package (arXiv serves the PDF alone) fails.
"""

from __future__ import annotations

import gzip
import io
import re
import subprocess
import tarfile
from pathlib import Path
from tempfile import TemporaryDirectory

import httpx
from cyclopts import App

from pdfbucket.provenance import read_record

# New-style ids (2301.01234) and old-style ids (math/0002066, math.AG/0002066), without version.
ARXIV_ID = re.compile(r"arxiv\.org/(?:pdf|abs|e-print)/((?:[a-z-]+(?:\.[A-Za-z]{2})?/\d{7})|(?:\d{4}\.\d{4,5}))", re.IGNORECASE)
DOCUMENT_CLASS = re.compile(r"^[^%\n]*\\documentclass", re.MULTILINE)
INPUT_ENCODING = re.compile(r"\\usepackage\s*\[([^\]]*)\]\s*\{inputenc\}")
INCLUDES = re.compile(r"\\(?:input|include)\s*\{([^}]*)\}")
REQUEST_TIMEOUT_SECONDS = 120

app = App(help="arXiv LaTeX source extraction plugin")


class ArxivSourceError(Exception):
    pass


def arxiv_id(pdf_url: str) -> str:
    found = ARXIV_ID.search(pdf_url)
    if found is None:
        raise ArxivSourceError(f"{pdf_url} is not an arXiv URL, so there is no arXiv source to fetch")
    return found.group(1)


def unpack(package: bytes, into: Path) -> None:
    """Write the source package's files under INTO: a tar archive, or one gzipped TeX file."""
    if package.startswith(b"%PDF-"):
        raise ArxivSourceError("arXiv has only a PDF for this paper, no LaTeX source")
    try:
        with tarfile.open(fileobj=io.BytesIO(package), mode="r:*") as archive:
            archive.extractall(into, filter="data")
    except tarfile.ReadError:
        (into / "main.tex").write_bytes(gzip.decompress(package))


def main_file(source: Path) -> Path:
    """The file with `\\documentclass` that no other TeX file includes; the largest if several remain."""
    texts = {path: path.read_text(encoding="utf-8", errors="replace") for path in sorted(source.rglob("*.tex"))}
    roots = [path for path, text in texts.items() if DOCUMENT_CLASS.search(text)]
    if not roots:
        raise ArxivSourceError("the source package has no .tex file with \\documentclass: it is plain TeX or another format that pandoc cannot read")
    included = {Path(name.strip()).stem for text in texts.values() for name in INCLUDES.findall(text)}
    unincluded = [path for path in roots if path.stem not in included] or roots
    return max(unincluded, key=lambda path: len(texts[path]))


def run(command: list[str], cwd: Path) -> bytes:
    done = subprocess.run(command, cwd=cwd, capture_output=True, check=False)
    if done.returncode != 0:
        raise ArxivSourceError(f"{command[0]} exited {done.returncode}: {done.stderr.decode(errors='replace').strip()}")
    return done.stdout


def decode(source: bytes) -> str:
    """SOURCE as text: in the encoding the paper declares with `inputenc`; else UTF-8, else Windows-1252, the 8-bit encoding of the undeclared sources that predate UTF-8."""
    declared = INPUT_ENCODING.search(source.decode("ascii", errors="ignore"))
    if declared is None:
        try:
            return source.decode("utf-8")
        except UnicodeDecodeError:
            encoding = "cp1252"
    else:
        encoding = {"latin1": "latin-1", "utf8": "utf-8", "utf8x": "utf-8"}.get(declared.group(1).strip(), declared.group(1).strip())
    try:
        return source.decode(encoding)
    except (UnicodeDecodeError, LookupError) as error:
        raise ArxivSourceError(f"the source is not valid {encoding} text: {error}") from error


def flatten(main: Path) -> str:
    command = ["latexpand", "--empty-comments"]
    bibliography = main.with_suffix(".bbl")
    if bibliography.exists():
        command += ["--expand-bbl", bibliography.name]
    return decode(run([*command, main.name], main.parent))


def markdown(flattened: Path) -> str:
    return run(
        ["pandoc", "--from", "latex-raw_tex", "--to", "markdown_strict+tex_math_dollars+citations+pipe_tables-raw_html", "--wrap=none", flattened.name],
        flattened.parent,
    ).decode("utf-8")


@app.default
def extract(pdf: Path, output: Path, arxiv_base: str) -> None:
    """Fetch the arXiv source of PDF from ARXIV_BASE and write OUTPUT/extraction.md and OUTPUT/artifacts/source.tex."""
    identifier = arxiv_id(read_record(pdf).provenance.pdf_url)
    response = httpx.get(f"{arxiv_base}/e-print/{identifier}", follow_redirects=True, timeout=REQUEST_TIMEOUT_SECONDS)
    response.raise_for_status()
    with TemporaryDirectory() as scratch:
        source = Path(scratch)
        unpack(response.content, source)
        main = main_file(source)
        flattened = main.parent / "flattened.tex"
        flattened.write_text(flatten(main), encoding="utf-8")
        text = markdown(flattened)
        if not text.strip():
            raise ArxivSourceError("pandoc produced no text from the flattened source")
        (output / "artifacts").mkdir()
        (output / "artifacts" / "source.tex").write_text(flattened.read_text(encoding="utf-8"), encoding="utf-8")
    (output / "extraction.md").write_text(text, encoding="utf-8")
