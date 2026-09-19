# Ditto 0.2 implementation plan

## Objective

Turn the file-organisation workflow from a workspace-only proof of concept into a practical, review-first batch tool for real user folders while preserving Ditto's non-destructive and review-integrity guarantees.

The release is complete only when a batch shaped like the insurance-DM case can be handled end to end without manual per-file edits:

- source and destination may be in separate, profile-authorised filesystem roots;
- `CODE_description.pdf` can declaratively capture `CODE`;
- output can be `PRO/PRO_FILES/CODE/CODE.pdf`;
- unmatched, unsafe, or colliding items appear as reviewable exceptions;
- one rule revision can regenerate the whole plan;
- a complete review manifest is available without flooding tool output;
- deterministic manifest/checksum/safe SQL sidecars can be reviewed and written with the batch;
- an optional ZIP is produced as a presentable deliverable;
- host approval outcome `unavailable` can use an explicit agent fallback, while rejection/cancellation still deny writes;
- old v1 recipes and the Code-to-Spec workflow remain compatible.

## Locked safety invariants

1. Sources are read-only: never modify, move, delete, import, or execute them.
2. Preview may write only durable review metadata under `stateRoot`.
3. Apply requires the exact persisted plan id, revision, and digest.
4. Source hashes are rechecked before and after copy.
5. No existing destination, sidecar, or archive may be overwritten.
6. All output paths remain beneath the reviewed destination root after canonicalisation.
7. Symlinks and junctions cannot escape any authorised root.
8. Regex and templates are data, never shell commands or executable code.
9. SQL sidecars support identifiers plus escaped literal/template values only; no raw SQL expressions.
10. `rejected` or `cancelled` host approvals always stop writes. Only `unavailable` may use a configured agent fallback.
11. Saved old plans/recipes remain readable or fail with an explicit migration message; never silently reinterpret reviewed state.
12. `stateRoot` and every category/file beneath it are link-checked at each read/write; swapping in a symlink or junction cannot redirect metadata or preview-manifest writes.
13. Summary and diagnostics are derived from item/artifact state and validated on load; approval wording never trusts a mutable persisted summary.
14. A crash after an exact destination copy but before status persistence is resumable by hash reconciliation, never misreported as an unrelated collision.

## Phase 0 — close existing integrity gaps

Before expanding the surface:

- harden `stateRoot`, category directories, temporary files, recipes, plans, spec batches, caches, and review manifests against symlink/junction replacement at every read/write;
- reject overlap in both directions between source and destination, and reject any source/output overlap with `stateRoot` that violates read-only discovery;
- recompute/validate summaries and diagnostics from items/artifacts instead of trusting saved counters; ensure approval reasons use derived counts;
- add durable intent/hash reconciliation so an exact reviewed destination left by a crash between copy and status save is adopted on resume, while any byte mismatch still fails closed;
- add adversarial tests for state-directory swaps, summary tampering, both overlap directions, and crash windows.

## Phase 1 — authorised filesystem roots

### Configuration

Add canonical, profile-owned allowlists:

- `allowedSourceRoots?: string[]`
- `allowedDestinationRoots?: string[]`
- `approvalUnavailable?: 'deny' | 'agent'`

Defaults preserve existing fail-closed behaviour:

- both allowlists default to `[workspaceRoot]`;
- `stateRoot` remains inside `workspaceRoot`;
- `approvalUnavailable` defaults to `deny` because DSH policy `never` intentionally reports `unavailable`; a profile owner must explicitly choose `agent` to rely on the conversational approval gate.

Absolute tool paths are accepted only when contained by an allowlisted canonical root. Relative paths remain anchored to `workspaceRoot`. Persisted plans are revalidated against the current allowlists on every status/revise/apply call.

Code-to-Spec continues to use the workspace boundary unless explicitly and safely migrated in the same root helper.

### Acceptance tests

- external source and destination in separately allowlisted roots work;
- a sibling path outside the allowlists fails with an actionable configuration example;
- cross-drive, junction, symlink, state overlap, source/output overlap, and changed persisted roots fail;
- existing workspace-only configuration behaves exactly as 0.1.

## Phase 2 — recipe v2: captures and nested destination templates

Introduce recipe version 2 while retaining a v1 reader/migration path.

### Match rule

- optional anchored regular expression, maximum 256 characters;
- scope: `basename` (default) or `relative-path`;
- flags limited to `i` and `u`;
- named captures only for template references;
- evaluate with a linear-time RE2-class engine or a strictly parsed linear grammar; heuristic JavaScript-RegExp deny-lists are not accepted;
- reject unsupported flags/features and unsafe/invalid expressions, including backreferences and lookarounds;
- bound match input length independently of filesystem assumptions.

### Destination template

Keep the existing tokens and add named captures:

- `{stem}`, `{ext}`, `{index}`, `{class}`
- `{match.<name>}`

Templates may contain reviewed literal relative path separators, but every capture expands as exactly one safe segment and cannot introduce `/`, `\\`, drive/UNC syntax, `.`/`..`, controls, reserved names, or trailing dot/space. Every rendered segment passes the existing Windows/device/trailing-dot safety rules and the full rendered value passes `safeRelative`. The source extension remains byte-for-byte mandatory.

Example:

```text
match_regex: ^(?<code>[^_]+)_.*\.pdf$
pattern: PRO/PRO_FILES/{match.code}/{match.code}.pdf
```

A non-match, unsafe capture, invalid destination, or collision becomes an item-level `exception` with a reason. It does not hide the rest of the preview or write anything.

### Acceptance tests

- the exact insurance-DM naming rule creates nested destinations;
- Unicode names and hyphenated codes work;
- traversal captures, absolute paths, reserved names, extension changes, and case-insensitive collisions become exceptions;
- v1 `{stem}` recipes produce byte-for-byte equivalent destinations.

## Phase 3 — batch rule revision

Add `ditto_revise_rule` rather than overloading per-item `ditto_revise`.

Input:

- plan id and exact revision;
- optional match regex/scope, destination pattern, classification, sidecars, and archive configuration.

Behaviour:

- disallow rule revision after any item/artifact has been applied;
- regenerate every proposal and exception deterministically;
- preserve explicit per-item overrides only when requested;
- increment revision and digest;
- return the bounded first page and refreshed diagnostics.

Per-item `ditto_revise` remains available for genuine exceptions.

## Phase 4 — complete review manifest

Add `ditto_manifest` as a read-only review tool. It requires the exact current plan id, revision, and digest so the exported document cannot be mistaken for a newer review.

- Formats: CSV, JSON, Markdown.
- Materialise under `stateRoot/reviews/<plan-id>/<revision>/` only.
- Include source-relative path, destination, source SHA-256, status, classification, and exception reason.
- CSV output must neutralise spreadsheet-formula prefixes from untrusted filenames; Markdown must escape active markup and render paths as data.
- Return path, format, byte count, SHA-256, row count, and plan identity; do not return the whole large document through the tool response.
- Manifest bytes must be deterministic for the same plan revision.
- Plan views expose diagnostics: ready, exceptions by reason, collisions, unmatched, and artifact count.

## Phase 5 — reviewed sidecar artifacts

Add deterministic artifacts to the plan identity.

Supported kinds:

1. `manifest`: CSV, JSON, or Markdown mapping.
2. `checksums`: SHA-256 list for planned output files.
3. `sql-insert`: a safe `INSERT ... VALUES` document using strict schema/table/column identifiers and escaped literal/template values only.

SQL sidecars explicitly forbid raw expressions, comments, batch separators, commands, and arbitrary statement templates. Identifiers are strictly validated; string literals escape apostrophes and support Unicode safely. They are text deliverables, never executed by Ditto.

Add `ditto_artifact_review`, keyed by exact plan id/revision/digest and artifact id, to return paged/bounded rendered content plus its SHA-256 before apply. Artifact destinations are output-root-relative, collision checked against file destinations and each other, and included in the plan digest.

Apply writes artifacts only after all copyable items have reached a successful/applied state. A failed or rejected copy prevents artifact creation until resume succeeds.

## Phase 6 — optional ZIP deliverable

Add a reviewed archive option to the recipe:

- `none` (default)
- `zip` with a safe output-root-relative destination such as `ditto-bundle.zip`

The ZIP is generated only after all copies and sidecars succeed, contains every reviewed output except itself, has deterministic entry ordering, does not follow links, and never overwrites an existing archive. Apply/status returns `deliverables` containing the output root, review manifest, sidecars, and archive path so the agent can present the archive instead of hundreds of files.

## Phase 7 — approval fallback compatible with policy `never`

Change host approval handling without bypassing DSH's fail-closed policy:

- `allowed-once` → proceed as `host`;
- `rejected` or `cancelled` → deny unconditionally;
- `unavailable` → proceed as `agent` only when the profile owner explicitly configured `approvalUnavailable: agent`, otherwise deny;
- no approval service → retain the existing configured agent fallback.

The default remains fail closed. Document that policy `never` intentionally yields `unavailable`, that enabling the fallback is a profile-owner decision, that the skill's explicit conversational approval remains required, and that the fallback is not proof of human approval. Update doctor/error output with the exact profile configuration needed instead of silently weakening the gate.

## Phase 8 — schemas, docs, compatibility, and release

- Update native tool schemas, descriptions, catalog, generated `docs/TOOLS.md`, bundled skill, English and Traditional Chinese READMEs, architecture, safety table, roadmap, changelog, Cordis configuration example, CLI/demo/UI/doctor, hard-coded tool counts, and package smoke assertions.
- Keep external allowlists isolated to file organisation; Code-to-Spec stays workspace-bound and retains its existing recipe/digest behaviour.
- Validate current plan identity and readiness before requesting host approval; approval wording uses only derived/authenticated counts and lists reviewed artifacts/archive.
- Add golden persisted v1 recipe/m0 plan fixtures. Preserve legacy digest/destinations exactly or fail with an actionable migration error; list/get must not silently hide corrupt or future recipes.
- Add a real 174-item synthetic integration fixture shaped like `CODE_description.pdf` and assert zero manual edits, zero source changes, nested outputs, complete manifest, safe SQL, and ZIP contents.
- Keep Code-to-Spec tests green.
- Bump package version to `0.2.0`.
- Run `npm run release:check` and `npm run smoke:profile` when the local environment supports it.
- Inspect `npm pack --dry-run`/tarball contents.
- Commit the implementation and push `main` to `origin` only after the complete gate passes.
- Do not publish npm automatically. Return the exact publish command to the user.

## Non-counting outcomes

The work is not complete if any of these remain true:

- external paths work only by copying data into Ditto's workspace;
- 174 files require 174 `ditto_revise` edits;
- nested destinations require manual overrides;
- a full mapping exists only in paged chat output;
- sidecars are unreviewed or can contain raw executable SQL;
- policy `never` always makes apply impossible despite configured agent fallback;
- the agent still has to create a ZIP outside the reviewed plan;
- documentation claims a guarantee without an automated test;
- tests pass only by weakening an existing safety invariant.

## Release evidence required

- clean `git diff --check`;
- full Vitest pass;
- TypeScript build pass;
- generated tool docs check pass;
- DSH smoke pass;
- tarball smoke pass;
- profile smoke pass or a concrete environment blocker;
- final `git status --short` clean after commit;
- pushed commit hash and GitHub remote branch;
- npm publication command (not executed).

## Current implementation and release status

Implemented in the 0.2 working tree:

- **Phase 0** — state root/category/leaf link hardening, derived summaries/diagnostics, two-way overlap rejection, durable exact-hash copy/sidecar/archive recovery, artifact/archive collision graph, and filesystem-backed cross-process mutation locks.
- **Phase 1** — role-specific `allowedSourceRoots` / `allowedDestinationRoots` (default `[workspaceRoot]`), workspace-anchored relative paths, persisted-root revalidation, and unchanged workspace-only Code → Spec scope.
- **Phase 2** — Recipe v2 with linear-time `re2-wasm`, named captures, nested templates, v2 `{ext}` with its leading dot, item-level reviewed exceptions, and frozen v1 compatibility fixtures.
- **Phase 3** — whole-rule `ditto_revise_rule`, with deterministic rerendering of proposals, exceptions, sidecars, and archive identity; `ditto_preview` also accepts initial sidecars/archive.
- **Phase 4** — exact-identity complete manifest export (CSV/JSON/Markdown), including exceptions and formula neutralisation.
- **Phase 5** — reviewed manifest/checksum/literal-only SQL sidecars with deterministic renderer/hash identity and bounded artifact review. SQL Server, PostgreSQL, and SQLite output is text only and is never executed.
- **Phase 6** — deterministic streamed classic ZIP from the persisted allowlist only, explicit 65,535-entry/<4-GiB limits, exact central-directory acceptance tests, and copy → sidecar → archive ordering.
- **Phase 7** — exact identity is validated before approval; `approvalUnavailable` defaults to `deny`, agent fallback is explicit, and rejection/cancellation always deny.
- **Phase 8 coverage** — 17 tools, golden 0.1 plan/recipe fixtures, durable crash-window tests, and a true 174-file insurance-style integration test with complete manifest, SQL, nested outputs, source-byte preservation, and exact ZIP entries.

Release-facing documentation and generated `docs/TOOLS.md` were updated for 0.2.0. Evidence recorded for this build:

- `git diff --check` clean;
- `npm run release:check` green — TypeScript build, 86/86 Vitest tests across 10 files, real Cordis + published ToolRuntime/SkillRegistry component smoke, generated-doc drift check, and packed-tarball clean-install smoke;
- `npm pack --dry-run` inspected (79 files: `dist`, `skills`, `cordis.patch.yml`, licenses, READMEs, CHANGELOG — no source, docs, or tests);
- `npm run smoke:profile` green against the DSH 0.1.5-rc.2 launcher in an isolated `DSH_HOME`: `dsh plugin add` from the packed tarball, profile boot with Ditto in the tree, and in-profile doctor reporting 17 of 17 tools and skill `ditto`.

The npm publication command is provided but **not executed**.
