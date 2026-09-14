# DSH new-plugin adversarial product review

Date: 2026-09-13. You are a product/architecture discussion partner. Respond only with analysis; do not use tools or write code. The user explicitly authorized consulting the installed Claude CLI and wants us to decide without asking questions. The implementation will be written by GPT-5.6 Terra.

Verified local context:
- KeepGate is a native TypeScript/Cordis DSH plugin intended to improve weaker models through tasks, criteria, runtime observation receipts, retry locks, and completion authorization.
- Corrected 25-trial coding baseline: all 5 modes tied on correctness; median Standard 11.5s, KeepGate Auto 45.5s. Performance verdict RED. Small ceiling-limited benchmark, not broad proof of failure.
- SWE-bench django-13344: Standard, Code and KeepGate all failed both real target tests; 356 existing regression tests passed. KeepGate faithfully recorded passing model-chosen tests and authorized completion while the real issue remained unsolved. Honest execution is not semantic correctness; same model authored criterion, patch and self-test.
- Current local DSH checkout is 0.1.0-rc.5, commit 47f943859bef60e4160492346772ded9b24f765a (2026-08-13).
- Official GitHub latest release is dsh-v0.1.5-rc.2 dated 2026-09-10; npm latest resolves 0.1.5-rc.1 at this observation. New upstream already has richer file delivery/sidebar, model improvements, resume, compaction, and experimental agent teams. Do not invent APIs.
- Ecosystem already includes many generic memory, skill, search, model bridge, plugin manager, exports and checkpoint products. Novelty needs competitor verification, not a claim nobody has ever done this.

Our current leading candidate, provisional name DSH Recheck:
Automatically retain *which checks actually ran against which workspace state*, then mark earlier green checks stale after code/config/dependency changes or resumed sessions. Produce a compact handoff/review card listing observed pass/fail/unknown/stale, changes since verification, next suggested checks. No extra LLM calls in the critical path; passive by default; no blocking or completion authority. First useful slice is a deterministic TypeScript core + explicit command execution adapter + native DSH tool-result observer where source-verified. Workspace checks bind to an honest declared scope (conservative whole-repo fallback). No claims that command success proves issue fixed. No auto-replay of arbitrary commands. Do not store raw stdout, source contents, secrets, or shell command text by default. User-visible difference: green results automatically expire when the evidence no longer describes today's files, and survive compaction/restart with provenance.

Other candidates: (B) workspace-aware resume capsule: fact freshness with files/failure attempts; (C) native environment doctor which diagnoses missing shell/runtime/tools before wasting model retries; (D) intent-to-behavior regression helper deriving external independent acceptance tests, potentially larger semantic correctness challenge.

Please return, in Traditional Chinese and under 1300 words:
1. Rank these ideas on broad real pain, feasibility, differentiation, and adoption friction. Challenge the leading idea hard.
2. Choose one narrow valuable wedge, explain what existing CI/test runners/memory already do and why a DSH user would install this.
3. Give exact MVP boundaries, 5 measurable acceptance scenarios, stop/go conditions, and a staged roadmap.
4. Identify the top 5 ways this repeats KeepGate's failure and how to prevent them.
5. Suggest a stronger alternative if none is compelling. Distinguish evidence from speculation. Do not claim worldwide novelty or majority validation.
