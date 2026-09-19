# Compatibility

DeepSeek Harness is pre-1.0 and moves quickly. Ditto declares exactly which versions it is tested against rather than claiming broad compatibility. The authoritative table lives in [`src/compat.ts`](../src/compat.ts) and is what `dsh-ditto doctor` reports against.

## Matrix

| Ditto | DSH launcher / components | Node.js | OS | Status | Evidence |
|---|---|---|---|---|---|
| 0.2.0 | `@deepseek-ai/dsh` 0.1.5-rc.1 with `dsh-tools` / `dsh-skill` 0.1.5-rc.1 | 22, 24 | Ubuntu, Windows | **release candidate** | build, unit/safety suite, component-host smoke, generated-doc check, packed-tarball smoke, and a real isolated-`DSH_HOME` profile install, boot, and in-profile doctor run |
| 0.2.0 | `@deepseek-ai/dsh` launcher 0.1.5-rc.2, whose installed closure resolves rc.2 components | 24 | Windows | **verified locally** | `npm run smoke:profile` passed end to end: `dsh plugin add` from the packed tarball, profile boot with Ditto in the tree, and in-profile doctor reporting 17 of 17 tools |
| 0.2.0 | `dsh-tools` / `dsh-skill` `next` / `alpha` | 22, 24 | CI matrix | **canary** | non-blocking compatibility jobs |
| 0.1.0 | `@deepseek-ai/dsh` 0.1.5-rc.1 / rc.2 | 22, 24 | Ubuntu, Windows | **supported historical release** | 0.1 release gates and real profile smoke |

"Supported" means the complete gate passes; "canary" means we run against it so an upstream breaking change is noticed early, but it is not a promise.

## What Ditto depends on

- **Runtime peer packages:** `@deepseek-ai/cordis ^4.0.2`, `@deepseek-ai/dsh-tools >=0.1.5-rc.1 <0.2.0`. They are peers, so the plugin uses the host's own module instances (see [ARCHITECTURE.md](ARCHITECTURE.md#how-dsh-loads-ditto)).
- **Runtime dependency:** `re2-wasm`, used for linear-time Recipe v2 matching. ZIP and SQL sidecars use Node APIs and never shell out.
- **Host services:** `tools` and `skills` are required at mount time; `approval` is optional and read at call time.
- **Public APIs only:** `defineTool` and `ToolRuntime.register` from `dsh-tools`, `SkillRegistry.register` from `dsh-skill`, `Service`/`Context` from `cordis`, and the documented `ApprovalService.request` from `dsh-user-approval`. Ditto patches nothing in DSH.
- **Node.js:** 22 or later (`engines.node >=22`). CI runs 22 and 24.
- **pnpm:** required by `dsh plugin` itself, not by Ditto.

## Known upstream quirks

- The npm `latest` dist-tag of `@deepseek-ai/dsh-tools` pointed at a stale `0.0.1-rc.1` when this was written. Always install DSH packages with an explicit version or the `next`/`alpha` tags; Ditto's peer range starts at 0.1.5-rc.1.
- Published DSH packages declare `^0.1.5-rc.x` ranges across each other, so an npm install can mix rc.1 and rc.2 components. A DSH profile installs one consistent closure; the tarball smoke pins the closure with npm `overrides` for the same reason.
- `dsh --profile <name> --dump-config` composes the plugin tree but does not create the module fallback links; a first real boot does. If `dsh plugin --profile <name> exec dsh-ditto doctor` reports that `@deepseek-ai/cordis` is not resolvable, boot the profile once and run the doctor again.

## How CI catches a breaking change

- `test` job (blocking): Node 22 and 24 × Ubuntu and Windows — build, unit and safety tests, component-host smoke, tool-doc drift check, tarball clean-install smoke.
- `profile-install` job (blocking, Ubuntu): installs `@deepseek-ai/dsh` and pnpm, then runs the real `dsh plugin add` / boot / doctor smoke in an isolated `DSH_HOME`.
- `dsh-next` and `dsh-alpha` jobs (non-blocking): the same suite against the `next` and `alpha` dist-tags, so a failing canary shows up before users hit it.

## Reporting a compatibility problem

Open an issue with the **DSH compatibility** template (`dsh compatibility` label). Include `dsh --version`, the output of `dsh plugin --profile <name> exec dsh-ditto doctor`, and the `dsh: plugin tree failed to load: …` line if the profile fails to boot. If a new DSH release breaks Ditto, the fix will ship as a patch release with this table updated.
