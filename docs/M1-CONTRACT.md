# M1 contract: batch code to specification

Decision date: 2026-09-15. All implementation code is owned by GPT-5.6 Terra agents. Root owns this contract and independent acceptance.

## Product outcome

Given a TypeScript or JavaScript repository containing roughly 10–50 relevant source modules, Ditto selects three structurally different samples, generates evidence-backed Markdown specifications, accepts direct user edits to those samples, and uses the approved examples plus explicit instructions to process the remaining modules as one reviewed batch.

The advantage is batch calibration and completeness. M1 does not watch the repository, synchronize later changes, operate on Git diffs, or claim that the model learns a permanent semantic transformation.

## Pipeline

`acquire -> prepare -> generate -> validate -> preview -> apply`

- **Acquire:** enumerate bounded source files, preserve relative paths, hash bytes, and reject traversal/symlink escapes. Initial language scope is TypeScript/JavaScript.
- **Prepare:** extract line-numbered evidence chunks and deterministic structural facts. Give every chunk an opaque evidence id tied to path, line range, and content hash.
- **Generate:** use a replaceable generator interface. Initial samples use explicit instructions; remaining modules also receive the approved sample specifications as few-shot examples. Persist model request/response metadata needed for audit, excluding credentials.
- **Validate:** accept structured drafts only. Every factual section must cite existing evidence ids. Resolve citations to real paths and line ranges. Unsupported claims become `待確認`; invalid paths, ids, ranges, or output names fail the item.
- **Preview:** show three editable samples first, then every discovered module with proposed output path, status, specification preview, and evidence links. User edits create a new revision and digest.
- **Apply:** require the exact reviewed revision and digest, recheck source hashes, write Markdown only into a separate output root, never overwrite existing files silently, and persist actual per-item results for resume.

## Minimal specification shape

Each draft has a stable JSON form before Markdown rendering:

- module id, relative source path, proposed output path
- title and one-paragraph purpose
- responsibilities
- public API: exported functions/classes/types and known parameters
- dependencies
- observable errors or edge cases
- items requiring confirmation
- citations by evidence id for every factual list item or paragraph

Empty sections are omitted. The renderer owns Markdown formatting; model output never supplies paths to write or executable content.

## User workflow

1. Start a spec batch from a repository root and a fresh output folder.
2. Review three diverse sample modules and their evidence-backed specifications.
3. Edit the Markdown samples and optional batch instructions.
4. Approve the samples; Ditto records them as versioned few-shot examples.
5. Generate and inspect the remaining batch. Missing or invalid evidence is grouped under `待確認`.
6. Approve the complete preview and write all valid Markdown specifications.
7. Inspect per-module success, skipped, failed, and needs-review results.

## Acceptance gates

- A synthetic repository with at least 12 modules completes the full browser flow and writes at least 12 specifications.
- Discovery reports every in-scope module exactly once; exclusions are explicit and counted.
- Every rendered factual claim has at least one citation resolving to an existing source path and valid line range.
- A deliberately hallucinated evidence id is rejected deterministically before writing.
- Editing an approved sample changes recipe digest and affects at least one held-out module under a test generator.
- Source changes after preview reject apply; source files remain byte-identical after success and failure.
- Duplicate/case-insensitive output collisions, traversal, symlink escape, and overwrite attempts are rejected.
- Interrupted apply resumes without duplicating completed outputs.
- DSH public integration exercises real registered tools and the real published component host. A deterministic fake generator is allowed only for automated core/UI tests and must be labelled.
- Test reporting separates deterministic structure/evidence results from model quality. No aggregate score can hide missing modules or invalid citations.

## Initial non-goals

- Automatic synchronization, file watching, scheduled runs, Git-diff processing.
- Languages beyond TypeScript/JavaScript.
- Executing or importing the target repository's code.
- Producing OpenAPI as the primary output, modifying source code, or writing inside the source tree.
- Claiming semantic correctness solely because citations exist.
