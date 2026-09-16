# DSH Ditto

[English](README.en.md) · [繁體中文](README.md)

> **When work repeats, switch automatically to a batch workflow you can review.**

DSH Ditto is a native DSH Skill for repeated work. Users describe the outcome as usual; when an agent detects a folder, several modules, a repeated format, or a review-then-batch request, it loads Ditto. Ditto starts with three structurally different examples so the user can set the standard, then applies the approved rule to the remaining work.

It is built for turning 10–50 modules into consistent API documentation, module references, test-case checklists, or pre-refactor behavior specifications. It can also organize a batch of files under one reviewed rule.

## Describe the outcome normally

There is no need to type `use Ditto` or remember tool names. Tell DSH what you want:

> Create consistent API specifications for every module in this project, then show me three samples before processing the rest.

> Organize every file in this folder using this naming rule. Show a full preview and its exceptions first.

Requests like these load the Ditto Skill. Ordinary questions, one-file edits, and an explicit request not to use Ditto do not.

## With and without Ditto

| Situation | Without Ditto | With Ditto |
| --- | --- | --- |
| Specifications for 20 modules | The agent works file by file; prompts must keep format and coverage consistent | It identifies batch specification work and calibrates the standard on three representative samples |
| One rule across a folder | The user must split the work, track exceptions, and check for omissions | Ditto prepares a full preview and exception list before the approved batch runs |
| Source evidence | Evidence depends on each individual conversation | Specification claims link to source files and line ranges; unsupported content is marked for review |
| Writing results | A model can edit before the whole scope has been reviewed | Documentation and file operations remain behind sample or preview approval gates |
| Resuming work | The user must reconstruct what finished and what remains | Durable batch state lets the agent reopen, review, and continue the same batch |

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

Ditto does not store provider keys or call a model directly. Once a DSH agent selects the Skill, it provides safe batch planning, sample review, source evidence, and write tools that remain locked until approval.

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
