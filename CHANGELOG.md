# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-09-17

First public release.

### Added

- Native DeepSeek Harness plugin (`dsh-ditto/dsh`): one Cordis service that registers the `ditto` skill and 14 typed native tools on the host's public `skills` and `tools` services, with clean unload.
- `skills/ditto/SKILL.md` as the single source of truth for the skill (DSH frontmatter, loaded at runtime).
- Code → Spec workflow for TypeScript/JavaScript: bounded discovery with exclusion accounting, line-numbered evidence chunks, three structurally different calibration samples, citation-validated JSON drafts, deterministic Markdown rendering, "Needs confirmation" for unsupported claims, revision/digest gates, durable resumable apply.
- File-organisation workflow: declarative naming recipes, per-file review, copies into a new folder, saved recipes.
- Host approval gate: with a DSH approval service present, `ditto_apply` and `ditto_spec_apply` ask the user before writing (`approval: host`, the default).
- `LanguageAdapter` seam with the shipped TypeScript/JavaScript adapter.
- `dsh-ditto` CLI: `demo` (browser and `--headless`), `demo-files`, `doctor`, `serve`, `--version`, `--help`.
- `dsh-ditto doctor`: Node, DSH, pnpm, profile installation, resolved DSH versions, in-process mount (tools and skill), workspace and state folder checks.
- One-line installation through `dsh plugin --profile <name> add dsh-ditto` (package declares `dsh.bundle.patch`; DSH packages are peer dependencies).
- Generated tool reference (`docs/TOOLS.md`) with a CI drift check; architecture, safety, compatibility, development, evaluation, roadmap, and launch documentation; English and Traditional Chinese READMEs.
- Smoke scripts: component host (`smoke:dsh`), packed-tarball clean install (`smoke:tarball`), and a real `dsh plugin add` + profile boot in an isolated `DSH_HOME` (`smoke:profile`).
- GitHub issue and pull request templates, labels, and a CI matrix (Node 22/24 × Ubuntu/Windows, real profile install, non-blocking DSH `next`/`alpha` canaries).

### Changed

- Product surface is English-first (tool results, error messages, rendered spec headings, review pages); the Traditional Chinese README is kept in step.
- Minimum batch size for Code → Spec lowered from 10 to 4 modules (three samples plus at least one to apply the standard to).
- Relative `stateRoot` values are anchored to `workspaceRoot` instead of the process working directory.

### Fixed

- A cross-drive path on Windows could be treated as inside the workspace by the native-tool boundary check; the core `within()` check is now used everywhere.

[Unreleased]: https://github.com/darrien1998/dsh-ditto/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/darrien1998/dsh-ditto/releases/tag/v0.1.0
