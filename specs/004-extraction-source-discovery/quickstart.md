# Quickstart: Structured Extraction and Source Discovery

## Prerequisites

- Bun dependencies installed.
- Rust toolchain available.
- The fixture extraction manifest is available through the existing test harness.

## Validate source-aware extraction

```bash
bun test tests/server-extractions.test.ts
```

Expected outcomes: arXiv LaTeX is offered only for eligible arXiv items; non-arXiv items
do not receive it directly; failed providers remain visibly failed and produce no
authoritative extraction.

## Validate discovery and promotion

```bash
bun test tests/server-sources.test.ts
cargo test -p pdf-bucket arxiv::tests
```

The integration scenario must capture a non-arXiv fixture, discover a confident candidate,
explicitly promote it, verify the promoted item is preferred and arXiv-eligible, verify the
original item and embedded provenance remain present, and verify low-confidence, malformed,
and non-arXiv candidates fail explicitly. Repeat promotion and verify it is idempotent.
Run the same scenario with the deterministic local Atom/PDF fixture boundary; no live
network or production-host bypass is permitted in the test.

## Full validation

```bash
just test-commit
just test-ci
```

Do not run manual provisioning for this feature. User-visible runtime verification uses the
normal launcher after implementation.

The discovery fixture corpus contains at least 20 known matches. The test asserts that at
least 19 rank in the accepted candidate set and records the elapsed time from extraction
completion to visible readiness/failure, which must be no more than 10 seconds.
