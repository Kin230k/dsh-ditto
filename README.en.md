# DSH Ditto

[English](README.en.md) · [繁體中文](README.md)

> **Shape three examples your way, then bring the same standard to the whole codebase.**

DSH Ditto turns one-file-at-a-time AI conversations into a reviewable batch workflow. It selects three structurally different modules from a TypeScript or JavaScript repository, lets you edit their specification examples directly, then applies the approved style to the remaining modules. Each claim links back to a source file and line range.

It is built for teams turning 10–50 modules into consistent API documentation, module references, test-case checklists, or pre-refactor behavior specifications.

## Why not just send code to AI?

AI handles one file quickly. Larger codebases create a different job: repeat the formatting rules, keep terminology consistent, find missing modules, and review every output. Ditto makes that work visible:

1. **Calibrate on three samples.** Edit Markdown directly instead of writing a long prompt.
2. **Preview the full batch.** Every module has a status and output path.
3. **Trace claims to evidence.** Facts cite real source locations; unsupported material becomes `Needs review`.
4. **Validate before writing.** Ditto never executes or edits source files. It writes documentation to a separate output directory.

```text
Scan repository → three specification samples → edit and approve → full batch preview → write Markdown
```

## What you get

- API and module specifications written to one standard
- Source evidence and per-module output results
- A single place to resolve uncertain items
- Batch state that can resume after interruption

The current M1 prototype supports TypeScript and JavaScript. It also retains M0's non-destructive document-organization workflow.

## Try it in 60 seconds

Requires Node.js 22 or later and npm.

```powershell
cd C:\Users\user\Desktop\dsh-ditto
npm install
npm run demo:spec
```

The command creates 12 synthetic modules and prints a local URL. Approve three samples, generate the complete preview, then write the specifications. The write action stays disabled until all 12 modules pass the workflow checks.

The demo uses a deterministic test generator. It validates the workflow and safety gates; it does not measure real model documentation quality.

## Using Ditto with DSH

Ditto is a native DSH Skill. Users describe the outcome normally and never need to remember tool names. When a request covers a folder, several modules, a repeatable rule, or a review-then-batch workflow, the agent selects Ditto from its skill catalog and loads the detailed workflow. Ordinary one-file edits and questions do not trigger it.

For example: “Create consistent API specifications for every module in this project, then show me three samples before processing the rest.” The agent loads Ditto, creates the batch, prepares the samples, and waits for approval. The plugin does not store provider keys or call a model directly.

Core tools:

`ditto_spec_create` → `ditto_spec_queue` → `ditto_spec_module` → `ditto_spec_submit` → `ditto_spec_review` → `ditto_spec_revise_samples` → `ditto_spec_approve` → `ditto_spec_apply`

## Validation and scope

```powershell
npm test
npm run build
npm run smoke:dsh
```

The project currently passes 26 automated tests, TypeScript compilation, a DSH component-host smoke test, and local browser verification of the complete-preview gate. Read the [validation record](docs/VALIDATION.zh-TW.md) for the evidence.

This is a local developer prototype. Real-model quality and time savings still need measurement on real repositories.

## Further reading

- [Product roadmap](docs/ROADMAP.zh-TW.md)
- [M1 engineering contract](docs/M1-CONTRACT.md)
- [M1 evaluation method](docs/M1-EVALUATION.zh-TW.md)
- [Implementation status](docs/IMPLEMENTATION-STATUS.zh-TW.md)
- [Validation record](docs/VALIDATION.zh-TW.md)

## License

[MIT](LICENSE)
