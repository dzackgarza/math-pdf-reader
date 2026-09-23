# PDF Bucket — standalone PDF reading bucket: browser capture, PDF.js reader, send to Zotero.
#
# Bun workspace under apps/ (server, web, extension, desktop) plus a Python package under
# plugins/ for extraction and resolver plugin wrappers. QC delegates to the global
# ai-review-ci bun-python profile; bun, uv, wxt, vite and tauri are implementation details.

# ai-review-ci contract variables consumed by doctor and workflow installers.
ai_review_ci_schema_version := "1"
ai_review_ci_profile := "bun-python"
ai_review_ci_ref := "main"
ai_review_ci_release_channel := "main"
ai_review_ci_workflow_template_version := "1"
ai_review_ci_local_delegation := "global-justfile"
ai_review_ci_default_branch := "main"

# List available recipes.
default:
    @just --list

# Build every app: web bundle, both extension targets, desktop binary.
build:
    @bun run build

# Start the bucket server on 127.0.0.1:8765 with hot reload.
serve:
    @bun run --filter @pdf-bucket/server dev

# Run the desktop window against a live server (starts the server first).
run:
    @bun run --filter @pdf-bucket/desktop tauri dev

# Run commit-tier Python and Bun QC through the central implementation.
test-commit:
    @just -f ~/ai-review-ci/justfiles/python.just -d . test-commit
    @just -f ~/ai-review-ci/justfiles/bun.just -d . test-commit

# Run the full Python and Bun test suites before pushing.
test-push:
    @just -f ~/ai-review-ci/justfiles/python.just -d . test-push
    @just -f ~/ai-review-ci/justfiles/bun.just -d . test-push

# Run CI acceptance QC through both central implementations.
test-ci:
    @just -f ~/ai-review-ci/justfiles/python.just -d . test-ci
    @just -f ~/ai-review-ci/justfiles/bun.just -d . test-ci
