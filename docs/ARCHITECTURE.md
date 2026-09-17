# Architecture

Ditto is a native DeepSeek Harness (DSH) plugin. This document describes what runs where, what the plugin depends on, how state and approvals work, and what the boundaries are. For the safety guarantees and the tests behind them see [SAFETY.md](SAFETY.md); for the tool reference see [TOOLS.md](TOOLS.md).

## The shape of the product

```text
User
 ↓  natural-language batch request
DSH agent
 ↓  `ditto` skill routing (skills/ditto/SKILL.md)
Ditto native tools                       ← src/dsh/tools/*.ts, registered on ctx.tools
 ↓  bounded evidence out, structured drafts in
Deterministic core                       ← src/core (files), src/spec (code → spec)
 ↓  discovery · evidence ids · citation validation · rendering · hashes · digests · durable state
Preview → Human approval → Apply
```

The core value is not a smarter model. It is that a batch of 20–50 similar items is calibrated on three reviewed samples, previewed in full, approved explicitly, and applied safely — instead of supervising 20–50 conversations.

## Package layout

| Path | Role |
|---|---|
| `src/dsh/service.ts` | `DshDitto`, a Cordis `Service` (`provide: 'dshDitto'`, `inject: ['tools', 'skills']`). Registers the skill and the tools in its constructor. |
| `src/dsh/skill.ts` | Loads `skills/ditto/SKILL.md` at runtime and turns its frontmatter into a `SkillRegistration`. The file is the only definition of the skill. |
| `src/dsh/tools/files.ts` | `ditto_preview`, `ditto_revise`, `ditto_apply`, `ditto_status`, `ditto_recipe` |
| `src/dsh/tools/spec.ts` | `ditto_spec_create`, `ditto_spec_queue`, `ditto_spec_module`, `ditto_spec_submit`, `ditto_spec_review`, `ditto_spec_revise_samples`, `ditto_spec_approve`, `ditto_spec_apply`, `ditto_spec_status` |
| `src/dsh/tools/shared.ts` | JSON result boundary, cancellation check, per-batch mutation lock, the human-approval gate |
| `src/dsh/catalog.ts` | Human-facing facts per tool (stage, writes, approval, failure cases). `scripts/gen-tools-doc.ts` merges it with the live schemas into `docs/TOOLS.md`; a test keeps it in step with the registered tools. |
| `src/dsh/config.ts` | Plugin configuration and its validation |
| `src/core/*` | File-organisation engine: recipes, plans, revisions, digests, atomic JSON state, safe copy apply |
| `src/spec/*` | Code → Spec engine: discovery, evidence chunks, draft validation, deterministic Markdown rendering, approval/recipe transitions, cached generation, safe write apply |
| `src/spec/languages/*` | The `LanguageAdapter` seam (TypeScript/JavaScript shipped) |
| `src/server.ts`, `src/ui/*` | Optional loopback-only review pages (no CDN, no third-party assets), used by the demo and `dsh-ditto serve` |
| `src/cli.ts`, `src/demo.ts`, `src/doctor.ts` | `dsh-ditto` command: demos, doctor, local page |
| `cordis.patch.yml` | The bundle patch DSH applies when the package is installed into a profile |

## How DSH loads Ditto

1. `dsh plugin --profile <name> add dsh-ditto` runs pnpm inside `$DSH_HOME/profiles/<name>` and, because `package.json` declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`, appends `dsh-ditto` to the profile's `dsh.profile.bundles`.
2. At boot, DSH composes the plugin tree: each bundle's patch list in order, then the profile's own `cordis.patch.yml`. Ditto's patch inserts one entry:

   ```yaml
   - insert:
       - id: ditto
         name: 'dsh-ditto/dsh'
         config:
           stateRoot: .dsh-ditto
   ```

3. The loader imports `dsh-ditto/dsh` (the `./dsh` export) and mounts `DshDitto` once its injected services (`tools`, `skills`) are available. Both come from `@deepseek-ai/dsh-base`, which every shipped profile except `sdk-minimal` includes.
4. Everything Ditto registers is a Cordis effect of its own fiber. Unloading the bundle, or a live reload of the patch layer, disposes the fiber and removes the skill, all 14 tools, and the `dshDitto` service. The test `registers the bundled skill … and removes them on unload` covers this on the real registry.

Module resolution follows DSH's two-anchor rule: the profile's own `node_modules` first, then the installation's dependency closure through `$DSH_HOME/profiles/node_modules`. That is why `@deepseek-ai/cordis` and `@deepseek-ai/dsh-tools` are **peerDependencies** — a second copy of the core inside the profile would give the plugin different `Service`/`Context` classes from the host's.

## Configuration

Set from the profile's own `cordis.patch.yml` by overriding the `ditto` entry (a user patch replaces the whole `config` object, so restate the fields you keep):

| Field | Default | Meaning |
|---|---|---|
| `workspaceRoot` | the DSH process working directory | The only directory tree Ditto may read sources from or write outputs into. Every tool argument path is resolved against it and must stay inside it. |
| `stateRoot` | `.dsh-ditto` (relative to `workspaceRoot`) | Durable plans, batches, recipes, and the generation cache. Must stay inside `workspaceRoot`; it is excluded from discovery when it sits inside a source folder. |
| `approval` | `host` | `host`: before any batch write, ask the DSH approval service (`ctx.approval`) for a one-shot grant tied to the tool call; fall back to `agent` when the host composes no approval service. `agent`: rely on the skill's rule that the agent has already shown the preview and obtained approval. |
| `maxItems` | 200 | Maximum files one file-organisation preview may enumerate (1–1000) |
| `resultItems` | 25 | Maximum item records per tool response (1–100); larger sets are paged with `nextOffset` |
| `evidenceItems` | 20 | Maximum evidence chunks per `ditto_spec_module` response (1–40); paged with `nextEvidenceOffset` |

Ditto's workspace boundary is its own check on top of whatever file sandbox the host enforces; it does not replace the host's permission model.

## The Code → Spec pipeline

`discover → prepare → generate → validate → preview → apply`, with the model step deliberately outside the plugin:

- **Discover.** Walk the source folder without following symlinks; skip `.git`, `node_modules`, build output, tests, and the state folder; claim files by extension through the language adapters; record every exclusion and its reason. A batch covers 4–50 modules (three samples plus at least one more; larger repositories are split into several batches).
- **Prepare.** Read each module as text (never import or execute it), hash the bytes, cut it into 24-line evidence chunks with ids derived from path + line range + content hash, and extract deterministic structural facts (exports, imports, line count).
- **Samples.** Choose three structurally different modules: the richest exporter, the module with the most imports, and the smallest. This is a deterministic spread, not a confidence score.
- **Generate.** Ditto never calls a model. `ditto_spec_module` hands the agent the evidence and facts (plus the approved samples for remaining modules); the agent returns a JSON `SpecDraft`. The local demo and the tests use a labelled deterministic generator instead.
- **Validate.** A draft is accepted only if it matches the module, uses only known fields, and cites existing evidence ids on every factual entry. Unsupported or uncertain statements must be `confirmations` — questions ending with `?`. Invalid drafts never reach the preview.
- **Render.** A deterministic renderer owns the Markdown: title, `Source`, `Purpose`, `Responsibilities`, `Public API`, `Dependencies`, `Errors and edge cases`, `Needs confirmation`, `Evidence`. Generator output never supplies a path or a template.
- **Review and approve.** The user edits the three sample Markdown files (every factual line must keep a `[ev_…]` citation) and the batch instructions. Any material edit bumps the revision, clears the approval, and discards held-out drafts. `ditto_spec_approve` records the three samples as the versioned recipe for this revision.
- **Preview.** Remaining modules are drafted against the approved samples. The preview shows every module, its output path, its status, and everything under "Needs confirmation".
- **Apply.** Requires the exact batch id, revision, and digest; re-checks every source hash and destination in a write-free preflight; writes each Markdown file through a temporary file with `wx` semantics; records per-module results after each write for resume.

## The file-organisation pipeline

A declarative recipe (`{stem}`, `{ext}`, `{index}`, `{class}` tokens plus an optional classification folder) produces a plan with one destination per source file. The user edits destinations; each edit is a new revision with a new digest. Apply copies files into the new output folder with `COPYFILE_EXCL`, verifying the source hash before and after the copy and the output hash after it. Recipes (rule + reviewed overrides) can be saved and reused; they contain no scripts or commands.

## Identity, revisions, digests

- A plan or batch id is a UUID. Each reviewed change increments `revision`.
- The `digest` is a SHA-256 over the reviewed identity: roots, recipe, samples, evidence, drafts, and rendered Markdown — but **not** over apply outcomes, so an interrupted batch keeps its identity while it resumes.
- Every mutating tool takes the exact `revision` (and, for approval and apply, the `digest`) and rejects anything stale with a message that tells the agent to read the current status and re-review with the user.
- Persisted state is validated on load (shape, digest, approval invariants) before it is trusted.

## Human approval

Two layers, both always on:

1. **Deterministic gate.** Apply requires the exact reviewed identity, a complete preview (every module rendered and validated), and, for Code → Spec, an approval record that matches the current revision. Nothing about this depends on the model behaving.
2. **Host prompt (`approval: host`).** When the DSH deployment composes `@deepseek-ai/dsh-user-approval`, `ditto_apply` and `ditto_spec_apply` call `ctx.approval.request()` with the tool call id and a human-readable reason. Only `allowed-once` proceeds; `rejected`, `cancelled`, and `unavailable` abort before any write. A headless deployment with approval policy `never` therefore cannot run batch writes — by design.

The skill additionally instructs the agent never to call an apply tool on its own initiative and to show the samples and the full preview before asking.

## Durable state

Under `stateRoot`:

| Folder | Contents |
|---|---|
| `plans/<id>.json` | File-organisation plans with per-item status |
| `recipes/<id>.json` | Saved naming recipes |
| `spec-batches/<id>.json` | Code → Spec batches: discovery, evidence, drafts, rendered Markdown, approval record, per-module status |
| `spec-cache/<hash>.json` | Generator responses keyed by source hash + recipe digest + generator id, so an edit to the samples does not force re-reading unchanged modules |

Writes are atomic (temporary file + rename). State never contains credentials; agent-supplied `metadata` on a draft is limited to short strings. Separate DSH processes must use separate state roots — the mutation locks are in-process.

## Language adapters

`src/spec/languages/types.ts` defines the seam:

```ts
interface LanguageAdapter {
  id: string                      // persisted with each module
  displayName: string
  extensions: ReadonlySet<string> // lower-case, with the dot
  exclude?(fileName): 'declaration-file' | 'generated' | undefined
  structuralFacts(text): { exports: string[]; imports: string[]; lineCount: number }
}
```

Evidence chunking, citation validation, rendering, hashing, and every safety gate are language-independent. A new language is one file plus tests; see [CONTRIBUTING.md](../CONTRIBUTING.md#adding-a-language-adapter).

## What Ditto deliberately does not do

No background folder watching, no scheduled runs, no shell or script recipes, no execution of generated code, no automatic source modification, no git commits or pull requests, no unattended batch writes, no cloud backend, no telemetry, no model routing, no API key management. Keeping the plugin small is the point; see [ROADMAP.md](ROADMAP.md).
