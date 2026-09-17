# Ditto

**Review a few. Ditto the rest.**

A review-first batch automation plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

[![npm](https://img.shields.io/npm/v/dsh-ditto.svg)](https://www.npmjs.com/package/dsh-ditto)
[![CI](https://github.com/darrien1998/dsh-ditto/actions/workflows/ci.yml/badge.svg)](https://github.com/darrien1998/dsh-ditto/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-0e7490.svg)](https://github.com/topics/dsh-plugin)

[English](README.md) · [繁體中文](README.zh-TW.md)

AI is great at doing one file. Ditto is for doing the same thing to 30 files without babysitting all 30.

You describe the batch job the way you always would. Ditto picks a few representative samples, lets you review and edit them until they look right, then applies the same standard to everything else — after showing you the full preview and asking for approval. Nothing is written until you say so.

```text
Discover → Review 3 samples → Approve → Preview everything → Apply
```

![dsh-ditto demo: discover 16 modules, review 3 samples, approve, preview everything, apply 16/16 with 0 source files modified](https://raw.githubusercontent.com/darrien1998/dsh-ditto/main/docs/assets/demo.svg)

## Installation

Ditto is a native DSH plugin. One command installs it into a DSH profile:

```bash
dsh plugin --profile web add dsh-ditto
```

`dsh plugin` forwards to pnpm inside the profile directory, so [pnpm](https://pnpm.io) must be on your PATH. Use `--profile headless`, `--profile acp`, or any custom profile name instead of `web` as needed.

| | |
|---|---|
| **Update** | `dsh plugin --profile web update dsh-ditto` |
| **Remove** | `dsh plugin --profile web remove dsh-ditto` |
| **Verify** | `dsh plugin --profile web exec dsh-ditto doctor` |

The doctor prints plain-language checks:

```text
✓ Ditto 0.1.0
✓ Node.js 22.23.1
✓ dsh 0.1.5-rc.1 detected
✓ pnpm 11.22.0 detected (used by "dsh plugin")
✓ dsh-ditto is installed in profile "web" and listed in its bundles
✓ 14 of 14 tools registered
✓ skill "ditto" registered
✓ stateRoot /your/project/.dsh-ditto is writable
```

Requirements: Node.js 22 or later, DSH 0.1.5-rc.1 or later (see [Compatibility](#compatibility)). If the host packages are not resolvable yet, boot the profile once (`dsh web`) so DSH links them, then run the doctor again.

## Quick start

Start DSH from the repository you want to work on and ask for batch work in plain language:

> Write a consistent Markdown spec for every module in `src/`. Show me three samples first.

You do not have to say "Ditto" or learn any tool names. When a request covers a whole folder, many similar modules, a repeated transformation, or a batch write that deserves a review, the DSH agent routes it through the `ditto` skill. Single-file edits and ordinary questions never trigger it.

Want to see the workflow before installing anything? The demo needs no model and no API key:

```bash
npx dsh-ditto demo --headless   # terminal transcript, 16 synthetic modules
npx dsh-ditto demo              # the same batch in a local browser review page
```

## Example: Code → Spec

Ditto's first use case is turning a TypeScript/JavaScript codebase into consistent, evidence-backed Markdown specifications.

1. **Discover.** Ditto scans the folder (skipping `node_modules`, build output, tests, declaration files) and reports exactly what is in scope and what was excluded, and why.
2. **Review three samples.** It picks three structurally different modules — the richest exporter, the module with the most imports, the smallest — and the agent drafts a spec for each from real, line-numbered source evidence. You edit the Markdown until it reads the way you want.
3. **Approve.** Your approved samples become the standard for the rest of the batch.
4. **Preview everything.** Every remaining module gets a spec in the same style. Every factual line cites the source lines it came from; anything the source cannot support is collected under **Needs confirmation** instead of being stated as fact.
5. **Apply.** After you approve the full preview, Ditto writes the Markdown files into a separate output folder — never into your source tree, never over an existing file.

A written spec looks like this:

```markdown
# src/routes/webhooks.ts [ev_670d8499c08cf407cc283778]

- Source: `src/routes/webhooks.ts`

## Purpose
- Provides `registerWebhookRoutes`. [ev_670d8499c08cf407cc283778]

## Public API
- **function registerWebhookRoutes**(router, handlers): … [ev_670d8499c08cf407cc283778]

## Needs confirmation
- Needs confirmation: Which event names does the webhook dispatcher accept at runtime? …

## Evidence
- ev_670d8499c08cf407cc283778: `src/routes/webhooks.ts:1-13`
```

## Example: File organisation

The same review-first loop works for organising copies of files under one rule:

> Organise everything in `inbox/` into `sorted/` by type, using `2026-{stem}` names. Show me the plan first.

Ditto previews every proposed destination, lets you fix individual names, and only then creates **copies** in the new folder. Originals are never moved or modified; existing files are never overwritten; a saved recipe can be reused on the next batch.

## How it works

```text
User
 ↓  "specs for every module, show me a few first"
DSH agent
 ↓  routes through the `ditto` skill
Ditto native tools (ditto_spec_create, …_module, …_submit, …_approve, …_apply, …)
 ↓  bounded evidence in, validated JSON drafts out
Deterministic core
 ↓  discovery · evidence ids · citation validation · rendering · hashes · digests
Preview → Human approval → Apply
```

- **The agent does the thinking; Ditto does the bookkeeping.** Ditto never calls a model itself and never stores model API keys. It hands the DSH agent bounded, line-numbered evidence and accepts only structured drafts whose every claim cites that evidence.
- **The batch is durable.** Every plan and batch is saved with a revision and a digest. Editing a sample or the instructions changes the digest, clears the approval, and locks the remaining modules until you approve again. An interrupted apply resumes without redoing or overwriting completed items.
- **The skill is the routing layer, not the product.** [`skills/ditto/SKILL.md`](skills/ditto/SKILL.md) is a plain file you can read; the plugin registers exactly that file. The full tool reference is generated from the live schemas in [`docs/TOOLS.md`](docs/TOOLS.md).

## Why Ditto

Prompt-only batch work tends to drift, miss files, format inconsistently, invent details, write too early, and lose its place when a session is interrupted. Ditto gives you:

- **Representative samples** to calibrate on, instead of re-explaining the format 30 times
- **Human review** of those samples, with your edits carried into the rest of the batch
- **A full preview** of every item before anything is written
- **Source evidence** on every claim, and **exceptions** collected in one place
- **Explicit approval** as a hard gate, not a suggestion
- **Safe apply**: copies and new files only, hashes re-checked, no overwrites
- **Resume** after interruption without duplicate work

Ditto does not make a model smarter and cannot guarantee that a spec is semantically correct. It makes the batch reviewable, consistent, and safe to apply.

## Safety by design

**Your source stays untouched. Nothing is batch-written before approval. Ditto does not execute your source code. Ditto does not store your model API keys.**

Every guarantee below is enforced by code and covered by an automated test; the mapping is in [`docs/SAFETY.md`](docs/SAFETY.md).

- Preview performs zero writes to sources or outputs; only local review metadata is saved
- Source files are read as text and never executed, imported, modified, moved, or deleted
- Outputs go to a separate folder; an existing destination is never overwritten
- Every apply re-checks the source hashes and the plan revision and digest; a changed source or a stale review is rejected before any write
- Path traversal, symlink and junction escapes, duplicate and case-insensitive destination collisions are rejected
- A completed item is never re-run or overwritten on resume; a duplicate apply is a no-op
- Claims the source cannot support become **Needs confirmation** questions, not facts
- With a DSH approval service present, the host asks the user before every batch write (`approval: host`)
- No telemetry, no network access beyond DSH itself, no API key storage

## Plugin architecture

Ditto is a DSH plugin, not a Markdown skill. The package contains:

| Layer | What it is |
|---|---|
| Cordis service | `dsh-ditto/dsh` — one service that registers the skill and the tools on the host's public `skills` and `tools` services; unloading the bundle removes everything |
| Skill | `skills/ditto/SKILL.md` — the routing layer the agent reads (model- and user-invocable) |
| Native tools | 14 typed tools: 9 for Code → Spec, 5 for file organisation ([reference](docs/TOOLS.md)) |
| Deterministic core | discovery, evidence extraction, citation validation, rendering, hashing, revision/digest gates, durable state |
| Local review page | an optional loopback-only browser page used by the demo and `dsh-ditto serve` |

Ditto depends only on public DSH APIs (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-skill`) and patches nothing in DSH. Configuration (`workspaceRoot`, `stateRoot`, `approval`, paging limits) is set from the profile's `cordis.patch.yml`; see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Compatibility

| Ditto | DSH | Node.js | Status |
|---|---|---|---|
| 0.1.0 | 0.1.5-rc.1, 0.1.5-rc.2 | 22, 24 | supported — full CI gate, real `dsh plugin` install smoke |
| 0.1.0 | 0.1.6-alpha.1 | 22, 24 | canary — tests pass, non-blocking CI job |

DSH is moving fast; see [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) for what exactly is tested and how to report a breaking change.

## Development

```bash
git clone https://github.com/darrien1998/dsh-ditto.git
cd dsh-ditto
npm ci
npm run build
npm test                 # unit, core safety, UI, plugin contract, CLI
npm run smoke:dsh        # real Cordis + ToolRuntime + SkillRegistry component host
npm run smoke:tarball    # pack, clean-install, mount, run the installed CLI
npm run smoke:profile    # real `dsh plugin add` into an isolated DSH_HOME (needs dsh + pnpm)
```

More in [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Good places to start: a language adapter for Python, Java, C#, or Go (the seam is small and documented), custom spec templates, better sample selection, UI localisation, and documentation examples. Look for the `good first issue` and `help wanted` labels.

## Roadmap

See [`docs/ROADMAP.md`](docs/ROADMAP.md). In short: keep Ditto small, understandable, safe, DSH-native, and review-first. No background watchers, no scheduled runs, no unattended batch writes.

## License

[MIT](LICENSE)
