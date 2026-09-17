# Contributing to Ditto

Thanks for helping. Ditto is small on purpose: a review-first batch plugin for DeepSeek Harness whose value is sample calibration, a full preview, explicit approval, and safe apply. Contributions that keep it small, understandable, safe, and DSH-native are the easiest to merge.

## Before you start

- Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/SAFETY.md](docs/SAFETY.md). The safety table is the contract: any change that touches a gate needs a test, and the table needs the new row.
- Check [docs/ROADMAP.md](docs/ROADMAP.md) and the `good first issue` / `help wanted` labels for scoped work.
- For anything larger than a bug fix, open an issue or a Discussion first so we agree on the shape before you invest time.

## Setup

```bash
npm ci
npm run build
npm test
```

Node.js 22 or later. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the smoke commands (`smoke:dsh`, `smoke:tarball`, `smoke:profile`) and how to test against another DSH version.

## Pull requests

1. Branch from `main`.
2. Keep the change focused; one topic per PR.
3. Add or update tests. `npm test` must pass on Node 22 and 24; CI also runs the component-host smoke, the tool-doc drift check, and the tarball smoke on Ubuntu and Windows.
4. If you add or change a tool: update `src/dsh/catalog.ts`, run `npm run docs:tools`, and commit the regenerated `docs/TOOLS.md`.
5. If you change the skill: edit `skills/ditto/SKILL.md` only. Nothing else defines it.
6. Update `CHANGELOG.md` under "Unreleased".
7. Fill in the PR template. Explain what a user sees differently, and how you verified it.

Commit messages follow the conventional style already in the history (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).

## Adding a language adapter

This is the most useful contribution right now. The seam is [`src/spec/languages/types.ts`](src/spec/languages/types.ts):

```ts
export interface LanguageAdapter {
  id: string                          // e.g. 'python'; persisted with each module
  displayName: string                 // e.g. 'Python'
  extensions: ReadonlySet<string>     // lower-case, with the dot: new Set(['.py'])
  exclude?(fileName: string): 'declaration-file' | 'generated' | undefined
  structuralFacts(text: string): { exports: string[]; imports: string[]; lineCount: number }
}
```

Rules:

- Text in, facts out. Never import, compile, or execute the source. Regex or a light tokenizer is fine; facts are hints for sample selection and the model, not claims in the output.
- Register the adapter in `DEFAULT_ADAPTERS` in `src/spec/languages/index.ts` only after it has tests: discovery of a small fixture folder, exclusions, and `structuralFacts` on a few realistic snippets.
- Do not touch evidence chunking, validation, rendering, or apply — they are language-independent by design.
- Add the language to the README's "Example: Code → Spec" scope line and to `CHANGELOG.md`.

## Reporting bugs and proposing features

Use the issue templates. For anything that looks like a safety hole (writing outside the output folder, overwriting a file, bypassing approval, executing source), follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be kind and specific.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
