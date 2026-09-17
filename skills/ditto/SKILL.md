---
name: ditto
description: Review-first batch work. Use when a request covers a whole folder or codebase, several similar files or modules, a repeated transformation, batch documentation or organisation, or any batch write that should be reviewed before it happens. Never for a single-file edit or an ordinary question.
whenToUse: Use when the user wants the same thing done to many files or modules and would otherwise have to supervise each one; typical triggers are "every module", "the whole folder", "all of these", "same format for each", "specs/docs for the codebase", or "organise these files". Skip it for one-file edits, normal Q&A, one-off trivial tasks, or when the user opts out of Ditto.
user-invocable: true
---

# Ditto — review a few, ditto the rest

Ditto turns "do the same thing to many files" into one reviewed batch:

discover → choose 3 representative samples → generate the samples → user reviews and edits them → explicit approval → full batch preview → exception review → apply → durable, resumable result.

The user does not need to say "Ditto" or know any tool name. Route on the shape of the work.

## Routing

Use Ditto when the request involves:

- an entire folder or repository, or several similar modules;
- a repeated transformation applied to many files;
- batch documentation (for example, specifications for every module);
- batch file organisation (renaming or grouping copies of files under one rule);
- any batch write the user wants to review before it happens.

Do not use Ditto when:

- the task edits or explains a single file;
- it is an ordinary question or a one-off trivial task;
- the user explicitly says not to use Ditto.

## Rules that always apply

- Nothing is batch-written before the user explicitly approves. Never call `ditto_spec_apply` or `ditto_apply` on your own initiative.
- Show the user what will be written before asking for approval: the three samples first, then the full preview with its exceptions.
- Never invent paths, line numbers, routes, parameters, errors, or behaviour. Every factual statement in a specification draft must cite an evidence id (`ev_…`) that Ditto returned for that module. Put anything unsupported or uncertain under `confirmations` as a question — never state it as a fact.
- A stale revision or digest means the batch changed: read `ditto_spec_status` or `ditto_status`, show the user what changed, and continue from the current identity. A changed source file needs a new batch.
- Ditto never executes or modifies the user's source files, writes only into a separate output folder, and never overwrites existing files. Say so when the user asks what will happen.

## Workflow A — Code → Spec (TypeScript / JavaScript today)

1. `ditto_spec_create` with the repository folder and a fresh output folder. It returns the batch identity and three sample module ids.
2. For each sample: `ditto_spec_queue` (phase `samples`) → `ditto_spec_module` for its evidence → write a JSON `SpecDraft` from that evidence only → `ditto_spec_submit`.
3. Show the three rendered samples (`ditto_spec_review`). Ask the user to edit or accept them. Save edits with `ditto_spec_revise_samples`.
4. Only after the user explicitly approves the samples, call `ditto_spec_approve`.
5. `ditto_spec_queue` (phase `remaining`) → for each module, `ditto_spec_module` → draft in the same style as the approved samples → `ditto_spec_submit`.
6. Present the full preview: every module, its output path, its status, and everything under "Needs confirmation". Ask the user to approve the batch.
7. Only after that approval, call `ditto_spec_apply`. Report the per-module results.

## Workflow B — File organisation (copies, never moves)

1. `ditto_preview` with the source folder, a new output folder, and an optional naming pattern. Show the proposed names and any exceptions.
2. Fix names the user wants changed with `ditto_revise`.
3. Only after the user explicitly approves the displayed plan, call `ditto_apply`. Report the per-file results.
4. `ditto_recipe` can save the reviewed rule for the next batch.

## Resuming

Batches are durable. If a session was interrupted, `ditto_spec_status` or `ditto_status` returns the current revision, digest, and per-item outcomes; completed items are never redone or overwritten.
