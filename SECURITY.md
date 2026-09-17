# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | yes |

## What counts as a security issue

Ditto's safety promises are listed in [docs/SAFETY.md](docs/SAFETY.md). Anything that breaks one of them is a security issue:

- writing outside the configured output folder or the Ditto workspace
- overwriting an existing file
- modifying, moving, deleting, importing, or executing a source file
- applying a batch without the reviewed identity (id, revision, digest) or bypassing the approval gate
- accepting a draft whose claims do not cite real evidence
- escaping through symlinks, junctions, path traversal, or cross-drive paths
- leaking anything to the network (Ditto should make no connections except its loopback review page)

## Reporting

Please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting on this repository ("Report a vulnerability" under the Security tab). If that is unavailable, open an issue titled "Security contact request" without details and a maintainer will reach out.

Include the DSH and Ditto versions (`dsh --version`, `dsh plugin --profile <name> exec dsh-ditto doctor`), the steps, and what was written where. A failing test is the most helpful form of report.

You will get an acknowledgement within a few days. Fixes ship as patch releases with a changelog entry and, where sensible, a new row in the safety table.

## Scope notes

- Ditto stores plans, batches, recipes, and a generation cache as plain JSON under `stateRoot`. It never stores credentials or environment variables.
- Ditto's workspace boundary is an additional check; it does not replace the host's file sandbox or approval policy. Problems in DeepSeek Harness itself should be reported to the DSH project.
