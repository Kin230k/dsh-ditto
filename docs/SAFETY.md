# Safety by design

**Your source stays untouched. Nothing is batch-written before approval. Ditto does not execute your source code. Ditto does not store your model API keys.**

These are not policy statements; each one is enforced in code and covered by a test that runs in CI on every change (`npm test`, plus the real-host smokes). If you find a way around any of them, please report it — see [SECURITY.md](../SECURITY.md).

## Guarantees and where they live

| Guarantee | Enforced in | Covered by |
|---|---|---|
| Preview performs zero writes to sources or outputs; only local review metadata under `stateRoot` is saved | `createPlan`, `createSpecBatch`, `generateSpecBatch`, `submitSpecDraft` never touch the output folder | `tests/core/m0.test.ts` "previews without writes…"; `tests/dsh/native-tools.spec.ts` (output is ENOENT until apply) |
| Source files are read as text and never executed, imported, modified, moved, or deleted | `prepareModule` uses `readFile` only; apply paths copy or write elsewhere | `tests/spec/m1.test.ts` (source bytes identical after apply); `tests/cli/demo-and-doctor.test.ts` (16 hashes re-verified) |
| Outputs go to a separate folder; output inside the source folder is rejected | `createPlan`, `createSpecBatch` | `tests/core/boundaries.test.ts` |
| An existing destination is never overwritten | `applyItem`/`applyOne` check existence, write via temp + `COPYFILE_EXCL` / `wx`; spec apply preflight rejects existing outputs before any write | `tests/core/m0.test.ts` "…non-overwrite failure"; `tests/spec/m1.test.ts` resume test |
| Source hash re-validated at apply; a changed source is rejected before any write | `applyItem`, `applyOne`, spec `preflight` | `tests/core/m0.test.ts` "rejects stale source bytes…"; `tests/spec/m1.test.ts` "…rejects stale sources at apply" |
| Apply requires the exact reviewed plan id, revision, and digest; persisted state must agree | `applyPlan`, `applySpecBatch`, `assertSpecIdentity` | `tests/core/m0.test.ts` "…rejects stale apply identities"; `tests/dsh/native-tools.spec.ts` (stale revision rejected) |
| Digest covers the reviewed identity, not apply outcomes, so resume keeps identity | `withDigest`, `withSpecDigest` | `tests/spec/m1.test.ts` resume test |
| Path traversal, absolute paths, Windows device names, trailing dots/spaces rejected | `safeRelative`, `validateDestinationExtension` | `tests/core/m0.test.ts` "…unsafe or extension-changing edits" |
| Symlinks and junctions: discovery refuses them; an output root given through a link is canonicalised to its real location before the workspace check; a link that appears between preview and apply is refused before anything is written | `canonicalPath`, `assertNoLinkAncestor` (`src/core/paths.ts`), `collectFiles`, `collectSourceFiles`, `prepareDestinationRoot`, `prepareOutputRoot`, `safeOutput` | `tests/core/m0.test.ts` "canonicalises an output root given through a junction…"; `tests/dsh/native-tools.spec.ts` (junction pointing outside the workspace rejected); discovery counts `symlink` exclusions |
| Boundary checks compare canonical paths (native realpath, Windows 8.3 short names expanded), so a legitimate folder is never mistaken for a link and a link is never mistaken for a folder | `canonicalPath`, `canonicalPathSync`, `resolveConfig`, `checkedRoots` | CI runs the suite on Windows runners whose temp path is an 8.3 short name |
| Cross-drive paths are never "inside" a root (Windows) | `within` | `tests/core/m0.test.ts` "treats cross-drive and parent paths as outside a root" |
| Duplicate and case-insensitive destination collisions rejected | `assertNoCollisions`, `assertOutputCollisions` | `tests/core/m0.test.ts` "rejects case-insensitive collisions…" |
| Every factual claim cites real evidence; forged ids rejected before preview | `validateSpecDraft`, `validateReviewedMarkdown` | `tests/spec/m1.test.ts` "rejects hallucinated evidence…"; `tests/dsh/native-tools.spec.ts` (forged `ev_` rejected by the tool) |
| Unsupported claims become "Needs confirmation" questions, never facts | `confirmations` must be questions; renderer section | `tests/spec/m1.test.ts` "renders open questions…" |
| Editing samples or instructions invalidates approval and held-out drafts; remaining modules lock until re-approval | `reviseSpecBatch`, `hasCurrentSampleApproval`, tool gates | `tests/spec/m1.test.ts` "requires explicit approval…"; `tests/dsh/native-tools.spec.ts` (remaining locked) |
| A forged or stale approval record cannot unlock the batch | `assertSpecBatch`, `hasCurrentSampleApproval` | `tests/spec/m1.test.ts` "…cannot unlock held-out modules with stale approvals" |
| A written batch cannot be recalibrated or re-approved | `reviseSpecBatch`, `approveSpecSamples` | `tests/spec/m1.test.ts` "…locks a written batch" |
| Duplicate apply and resume never redo or overwrite completed items | `assertCompletedItem`, `assertCompleted`, per-item state saved after each write, in-process locks | `tests/core/m0.test.ts` resume test; `tests/spec/m1.test.ts` "resumes an interrupted apply…" |
| Tool arguments cannot leave the configured workspace | `checkedRoots`, `checkedPersisted*Roots` | `tests/dsh/native-tools.spec.ts` (preview outside the workspace rejected) |
| Host approval gate: with `approval: host` and an approval service present, nothing is written unless the host grants `allowed-once` | `requireHumanApproval` | `tests/dsh/plugin-contract.test.ts` "human approval gate" |
| Host guards and `tools/pre-execute` denials prevent writes | DSH ToolRuntime pipeline | `tests/dsh/native-tools.spec.ts` (guard and pre-execute denial leave no files) |
| No model calls, no API keys, no network beyond DSH and the loopback review page | no `dsh-llm` import; `createServer` bound to `127.0.0.1`; `fetch` only in browser-side review scripts | `tests/core/boundaries.test.ts` (static checks) |
| Bounded inputs everywhere | draft text ≤ 2,000 chars, lists ≤ 80, sample Markdown ≤ 12,000, instructions ≤ 8,000, batch 4–50 modules, evidence paging, request bodies ≤ 16 KB | validation in `draft.ts`, `prepare.ts`, `server.ts`; exercised by the suites above |

## What Ditto stores locally

Under `stateRoot` (default `.dsh-ditto` in the workspace): plans, recipes, spec batches (including evidence text and rendered Markdown), and a generation cache of agent drafts keyed by source hash and recipe digest. Nothing else. No credentials, no environment variables, no conversation transcripts. Delete the folder to forget everything.

## What Ditto does not protect against

- **Semantic correctness.** A citation proves a statement points at real source lines; it does not prove the statement is true. Review the samples and the "Needs confirmation" list.
- **The host's own permissions.** Ditto's workspace boundary is an additional check; it does not replace DSH's file sandbox or approval policy.
- **Concurrent processes.** Mutation locks are in-process. Two DSH processes sharing one `stateRoot` are unsupported.
- **A hostile local user.** State files are plain JSON on disk, validated on load but not encrypted.

## Reporting

Please report anything that looks like a way to write outside the output folder, overwrite a file, bypass approval, or execute source code — see [SECURITY.md](../SECURITY.md).
