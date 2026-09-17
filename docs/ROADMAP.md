# Roadmap

Ditto stays small, understandable, safe, DSH-native, and review-first. The roadmap is a list of things worth doing in that spirit, not a schedule.

## 0.1 — first public release

- Native DSH plugin with the `ditto` skill and 14 typed tools
- Code → Spec for TypeScript/JavaScript with evidence-cited Markdown, three-sample calibration, full preview, host-approval gate, safe apply, resume
- File organisation with reviewed copies and saved recipes
- One-line install (`dsh plugin --profile web add dsh-ditto`), `dsh-ditto doctor`, deterministic demo
- Tested against DSH 0.1.5-rc.1 / rc.2, canary against 0.1.6-alpha

## Next — help wanted

These are scoped so a contributor can take one without touching the safety core. Look for the matching labels in the issue tracker.

| Area | Item | Label |
|---|---|---|
| Language adapters | Python (`.py`: `def`/`class`/`import`), Java, C#, Go — one file each behind the `LanguageAdapter` seam | `language adapter`, `good first issue` |
| Spec templates | User-selectable section sets and headings (for example an "API reference" template or a "behaviour before refactor" template), validated the same way as today | `enhancement` |
| Sample selection | Better spread than "most exports / most imports / smallest" — for example by folder, by framework role, or by duplication | `enhancement`, `help wanted` |
| DSH Web | A native review panel in the DSH web UI instead of the loopback page | `ui`, `dsh compatibility` |
| Review page | Localisation (zh-TW first), keyboard flow, diff view for sample edits | `ui`, `good first issue` |
| Documentation | Real-world examples with different repository shapes; a screencast of the browser demo | `documentation`, `good first issue` |
| Community results | Evaluation write-ups following [EVALUATION.md](EVALUATION.md) | `documentation` |

## Later, maybe

- Batches larger than 50 modules as linked sub-batches
- A `ditto_doctor` native tool so the agent can self-diagnose
- Per-user default instructions and templates

## Not planned

Background folder watching, scheduled or unattended runs, shell or script recipes, executing generated code, automatic source modification, automatic git commits or pull requests, cloud backends, telemetry, model routing, API key management, an all-language parser, or a multi-agent orchestration layer. If Ditto needs any of these to be useful for you, it is probably the wrong tool, and that is fine.
