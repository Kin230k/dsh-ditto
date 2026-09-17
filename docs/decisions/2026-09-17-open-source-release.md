# 2026-09-17 — Open-source release of Ditto 0.1.0

Status: accepted. This record captures the decisions taken while turning the development prototype into the first public release, so later contributors do not relitigate them.

## Context

The prototype had a working deterministic core, a native DSH integration, and 26 tests, but it was packaged as a private scoped package with DSH packages as regular dependencies, documented as "a DSH Skill", and carried internal development notes in the tree and in the npm tarball. DSH itself is pre-1.0 and its plugin ecosystem discovers packages through the `dsh-plugin` GitHub topic and npm keyword.

## Decisions

1. **Name and identity.** npm package and GitHub repository are both `dsh-ditto` (unscoped, following the `dsh-*` convention of published community plugins). Version 0.1.0. Default branch `main`.
2. **Ditto is a plugin; the skill is its routing layer.** Every document and the package description say so. The skill's only definition is `skills/ditto/SKILL.md` in the DSH frontmatter format, loaded at runtime — no TypeScript copy, no build step to drift.
3. **DSH packages are peer dependencies.** Verified against the published launcher: profiles install plugins with pnpm (`autoInstallPeers: false`) and resolve host packages through DSH's fallback links, so a plugin that bundles its own `@deepseek-ai/cordis` would get different `Service`/`Context` classes from the host. The tarball smoke pins the closure with npm `overrides` because published DSH packages declare `^` ranges across rc tags.
4. **English-first product surface.** Tool results, error messages, rendered spec headings, CLI output, and the review pages are English; `README.zh-TW.md` carries the Traditional Chinese copy. Localisation of the review page is a community item.
5. **Host approval gate on by default.** `approval: host` asks `ctx.approval` (public `@deepseek-ai/dsh-user-approval` API) for a one-shot grant before every batch write when the service exists, and falls back to the skill's agent-asserted approval otherwise. The deterministic identity/digest gate is always on regardless.
6. **Minimum batch size 4** (three samples plus one), down from 10, so small repositories are not refused; the maximum stays 50.
7. **Internal development notes removed from the public tree** (agent assignments, milestone contracts, validation logs, research transcripts, a generated design-system file). The design content that mattered was rewritten into `docs/ARCHITECTURE.md` and `docs/SAFETY.md`. Git history was kept, but every commit was re-authored to the maintainer's personal identity before publication.
8. **Compatibility is declared, not assumed.** `src/compat.ts` lists supported (0.1.5-rc.1, rc.2) and canary (0.1.6-alpha.1) DSH versions; CI runs the supported set as blocking jobs and the canaries as non-blocking ones; the real-launcher smoke installs the packed tarball with `dsh plugin add`, boots the profile, and runs the doctor inside it.
9. **No benchmarks, no telemetry.** `docs/EVALUATION.md` describes what could be measured; nothing in CI calls a model; nothing leaves the user's machine.
10. **Scope stays small.** No watchers, schedulers, script recipes, code execution, source modification, git automation, cloud backend, model routing, or key management. Listed under "Not planned" in the roadmap.

## Consequences

- A DSH user can install with one command, verify with the doctor, and run a model-free demo in under five minutes.
- Every safety promise in the README maps to a test row in `docs/SAFETY.md`; a change that breaks a gate fails CI.
- New languages are one adapter file plus tests; the safety core is untouched.
- The public history contains no secrets or credentials (audited across all commits), and only the maintainer's personal identity.
