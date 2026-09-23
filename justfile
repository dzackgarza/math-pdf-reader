# PDF Bucket — always-on PDF reading bucket with browser hijack and promotion to Zotero.
#
# No source yet: the roadmap lives in the agent-memory vault (PLAN-PDF-BUCKET-ROADMAP).
# QC delegates to the global ai-review-ci docs-and-configs profile until code lands.

# ai-review-ci contract variables consumed by doctor and workflow installers.
ai_review_ci_schema_version := "1"
ai_review_ci_profile := "docs-and-configs"
ai_review_ci_ref := "main"
ai_review_ci_release_channel := "main"
ai_review_ci_workflow_template_version := "1"
ai_review_ci_local_delegation := "global-justfile"
ai_review_ci_default_branch := "main"

# List available recipes.
default:
    @just --list

# Run the commit-tier QC gate through global ai-review-ci (invoked by pre-commit).
test-commit:
    @just -f ~/ai-review-ci/justfiles/docs-and-configs.just -d . test-commit

# Run the push-tier QC gate through global ai-review-ci (invoked by pre-push).
test-push:
    @just -f ~/ai-review-ci/justfiles/docs-and-configs.just -d . test-push

# Run the CI-tier QC gate through global ai-review-ci.
test-ci:
    @just -f ~/ai-review-ci/justfiles/docs-and-configs.just -d . test-ci
