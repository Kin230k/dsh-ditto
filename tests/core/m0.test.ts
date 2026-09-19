import { createHash } from 'node:crypto'
import { cp, mkdtemp, mkdir, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyPlan, canonicalPath, createPlan, defaultRecipe, defaultRecipeV2, loadPlan, loadRecipe, recipeFromPlan, revisePlan, safeRelative, savePlan, stableDigest, validateRecipe, withDigest, within } from '../../src/core/index.js'
import { startLocalWorkbench } from '../../src/server.js'
import { reviewArtifact } from '../../src/core/artifacts.js'
import { buildZip } from '../../src/core/zip.js'
import { withStateLock } from '../../src/core/state-paths.js'
import type { Plan } from '../../src/core/types.js'

const roots: string[] = []
async function fixture(files: Record<string, string>): Promise<{ root: string; source: string; output: string; state: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ditto-')); roots.push(root)
  const source = join(root, 'source'); const output = join(root, 'output'); const state = join(root, 'state')
  for (const [name, contents] of Object.entries(files)) { const path = join(source, ...name.split('/')); await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, contents, 'utf8') }
  return { root, source, output, state }
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('reviewed file copies', () => {
  it('previews without writes, then copies exact bytes and preserves originals', async () => {
    const paths = await fixture({ 'notes.txt': 'original note', 'nested/data.csv': 'a,b\n1,2\n' })
    const before = await readFile(join(paths.source, 'notes.txt'))
    const plan = await createPlan({ sourceRoot: paths.source, destinationRoot: paths.output, recipe: defaultRecipe() })
    expect(plan.summary.ready).toBe(2); await expect(readFile(join(paths.output, 'text', 'notes.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    await savePlan(plan, paths.state)
    const result = await applyPlan(plan, { id: plan.id, revision: plan.revision, digest: plan.digest }, paths.state)
    expect(result.summary.applied).toBe(2)
    expect(await readFile(join(paths.output, 'text', 'notes.txt'))).toEqual(before)
    expect(await readFile(join(paths.source, 'notes.txt'))).toEqual(before)
  })

  it('derives summary and diagnostics instead of trusting persisted counters', async () => {
    const paths = await fixture({ 'one.txt': 'one' })
    const plan = await createPlan({ sourceRoot: paths.source, destinationRoot: paths.output, recipe: defaultRecipe() })
    await savePlan(plan, paths.state)
    const path = join(paths.state, 'plans', `${plan.id}.json`)
    const saved = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    saved.summary = { total: 999, ready: 999, exception: 0, applying: 0, applied: 0, rejected: 0, failed: 0 }
    saved.diagnostics = { ready: 999, exceptions: 0, exceptionsByReason: {}, collisions: 0, unmatched: 0, artifactCount: 999 }
    await writeFile(path, `${JSON.stringify(saved, null, 2)}\n`, 'utf8')
    const loaded = await loadPlan(plan.id, paths.state)
    expect(loaded.summary).toMatchObject({ total: 1, ready: 1 })
    expect(loaded.diagnostics).toMatchObject({ ready: 1, artifactCount: 0 })
  })

  it('rejects stale source bytes and never creates a stale output', async () => {
    const paths = await fixture({ 'notes.txt': 'before' }); const plan = await createPlan({ sourceRoot: paths.source, destinationRoot: paths.output, recipe: defaultRecipe() }); await savePlan(plan, paths.state)
    await writeFile(join(paths.source, 'notes.txt'), 'after', 'utf8')
    const result = await applyPlan(plan, { id: plan.id, revision: plan.revision, digest: plan.digest }, paths.state)
    expect(result.items[0]!.status).toBe('rejected'); await expect(readFile(join(paths.output, 'text', 'notes.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects case-insensitive collisions and unsafe or extension-changing edits', async () => {
    const paths = await fixture({ 'one.txt': '1', 'two.txt': '2' }); const plan = await createPlan({ sourceRoot: paths.source, destinationRoot: paths.output, recipe: defaultRecipe() })
    expect(() => revisePlan(plan, [{ id: plan.items[0]!.id, destination: 'text/X.txt' }, { id: plan.items[1]!.id, destination: 'text/x.txt' }])).toThrow('same destination')
    expect(() => revisePlan(plan, [{ id: plan.items[0]!.id, destination: 'text/new.md' }])).toThrow('original .txt extension')
    for (const value of ['../escape.txt', 'CON.txt', 'report. ', 'folder/AUX.txt', '/abs.txt', 'C:/abs.txt']) expect(() => safeRelative(value)).toThrow()
  })

  it('treats cross-drive and parent paths as outside a root', () => {
    expect(within('/workspace', '/workspace/a/b')).toBe(true)
    expect(within('/workspace', '/workspace', true)).toBe(true)
    expect(within('/workspace', '/workspace')).toBe(false)
    expect(within('/workspace', '/workspace/../elsewhere')).toBe(false)
    if (process.platform === 'win32') {
      expect(within('C:\\workspace', 'D:\\workspace\\file.txt', true)).toBe(false)
      expect(within('C:\\workspace', 'C:\\workspace\\sub', true)).toBe(true)
    }
  })

  it('uses locale-independent code-unit ordering for index templates', async () => {
    const paths = await fixture({ 'ä.txt': 'unicode', 'z.txt': 'ascii' })
    const recipe = { ...defaultRecipe('stable order'), pattern: '{index}-{stem}' }
    const plan = await createPlan({ sourceRoot: paths.source, destinationRoot: paths.output, recipe })
    expect(plan.items.map(item => item.relativePath)).toEqual(['z.txt', 'ä.txt'])
    expect(plan.items.map(item => item.destination)).toEqual([join('text', '1-z.txt'), join('text', '2-ä.txt')])
  })

  it('keeps extensionless names and dotfiles intact, including below dotted folders', async () => {
    const paths = await fixture({ 'archive.v1/README': 'read me', '.keep': 'keep' })
    const plan = await createPlan({ sourceRoot: paths.source, destinationRoot: paths.output, recipe: defaultRecipe() })
    expect(plan.items.map(item => item.destination).sort()).toEqual([join('other', '.keep'), join('other', 'README')])
    await savePlan(plan, paths.state)
    await applyPlan(plan, { id: plan.id, revision: plan.revision, digest: plan.digest }, paths.state)
    expect(await readFile(join(paths.output, 'other', 'README'), 'utf8')).toBe('read me')
    expect(await readFile(join(paths.output, 'other', '.keep'), 'utf8')).toBe('keep')
  })

  it('canonicalises an output root given through a junction, and rejects a junction introduced after the preview', async () => {
    if (process.platform !== 'win32') return
    const paths = await fixture({ 'notes.txt': 'note' }); const outside = join(paths.root, 'outside'); const junction = join(paths.root, 'output-link')
    await mkdir(outside); await symlink(outside, junction, 'junction')
    // A junction that exists at preview time is resolved to its real location, so the plan records where files will really go.
    const through = await createPlan({ sourceRoot: paths.source, destinationRoot: join(junction, 'new-output'), recipe: defaultRecipe() })
    expect(through.destinationRoot.toLowerCase()).toBe(join(await realpath(outside), 'new-output').toLowerCase())
    // A junction that appears between preview and apply is refused before anything is created through it.
    const plan = await createPlan({ sourceRoot: paths.source, destinationRoot: join(paths.root, 'later', 'new-output'), recipe: defaultRecipe() }); await savePlan(plan, paths.state)
    const elsewhere = join(paths.root, 'elsewhere'); await mkdir(elsewhere); await symlink(elsewhere, join(paths.root, 'later'), 'junction')
    await expect(applyPlan(plan, { id: plan.id, revision: plan.revision, digest: plan.digest }, paths.state)).rejects.toThrow('symlink or junction ancestor')
    await expect(readFile(join(elsewhere, 'new-output', 'text', 'notes.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('resumes recorded work and treats an unrecorded existing output as a non-overwrite failure', async () => {
    const paths = await fixture({ 'one.txt': 'one', 'two.txt': 'two' }); const plan = await createPlan({ sourceRoot: paths.source, destinationRoot: paths.output, recipe: defaultRecipe() })
    const first = plan.items[0]!; await mkdir(join(paths.output, 'text'), { recursive: true }); await cp(first.source, join(paths.output, first.destination))
    const resumed = { ...plan, items: plan.items.map(item => item.id === first.id ? { ...item, status: 'applied' as const } : item), summary: { total: 2, ready: 1, applied: 1, rejected: 0, failed: 0 } }
    await savePlan(resumed, paths.state)
    const result = await applyPlan(resumed, { id: resumed.id, revision: resumed.revision, digest: resumed.digest }, paths.state)
    expect(result.summary.applied).toBe(2)
    const separate = await fixture({ 'one.txt': 'one' }); const unrecorded = await createPlan({ sourceRoot: separate.source, destinationRoot: separate.output, recipe: defaultRecipe() }); await savePlan(unrecorded, separate.state)
    await mkdir(join(separate.output, 'text'), { recursive: true }); await cp(unrecorded.items[0]!.source, join(separate.output, unrecorded.items[0]!.destination))
    const failed = await applyPlan(unrecorded, { id: unrecorded.id, revision: unrecorded.revision, digest: unrecorded.digest }, separate.state)
    expect(failed.items[0]!.status).toBe('failed'); expect(failed.items[0]!.reason).toContain('already exists')
    expect(await readFile(join(separate.output, unrecorded.items[0]!.destination), 'utf8')).toBe('one')
  })

  it('adopts only an exact copy left after a durable applying intent', async () => {
    const paths = await fixture({ 'one.txt': 'one' })
    const plan = await createPlan({ sourceRoot: paths.source, destinationRoot: paths.output, recipe: defaultRecipe() })
    const item = plan.items[0]!
    await mkdir(join(paths.output, 'text'), { recursive: true })
    await cp(item.source, join(paths.output, item.destination))
    const interrupted = withDigest({
      ...plan,
      items: [{ ...item, status: 'applying' as const, copyIntent: { destination: item.destination, sourceHash: item.sourceHash, startedAt: '2026-01-01T00:00:00.000Z' } }],
    })
    await savePlan(interrupted, paths.state)
    const resumed = await applyPlan(interrupted, { id: interrupted.id, revision: interrupted.revision, digest: interrupted.digest }, paths.state)
    expect(resumed.items[0]).toMatchObject({ status: 'applied', copyIntent: undefined })
    expect(await readFile(join(paths.output, item.destination), 'utf8')).toBe('one')
  })

  it('resumes exact sidecar and archive outputs only after their durable intents', async () => {
    const paths = await fixture({ 'one.txt': 'one' })
    const recipe = {
      ...defaultRecipeV2('durable outputs'),
      sidecars: [{ kind: 'checksums' as const, destination: 'SHA256SUMS.txt' }],
      archive: { kind: 'zip' as const, destination: 'bundle.zip' },
    }
    const plan = await createPlan({ sourceRoot: paths.source, destinationRoot: paths.output, recipe })
    const item = plan.items[0]!
    const artifact = plan.artifacts[0]!
    await mkdir(join(paths.output, 'text'), { recursive: true })
    await cp(item.source, join(paths.output, item.destination))
    const content = reviewArtifact(artifact, { planId: plan.id, revision: plan.revision, sourceRoot: plan.sourceRoot, destinationRoot: plan.destinationRoot, items: plan.items }, recipe.sidecars)
    await writeFile(join(paths.output, artifact.destination), content, 'utf8')
    const zip = buildZip([
      { name: item.destination.replace(/\\/g, '/'), bytes: await readFile(item.source) },
      { name: artifact.destination, bytes: Buffer.from(content, 'utf8') },
    ].sort((a, b) => (a.name < b.name ? -1 : 1)))
    await writeFile(join(paths.output, 'bundle.zip'), zip)
    const archiveHash = createHash('sha256').update(zip).digest('hex')
    const interrupted = withDigest({
      ...plan,
      items: [{ ...item, status: 'applied' as const }],
      artifacts: [{ ...artifact, status: 'applying' as const }],
      archiveState: { status: 'applying' as const, contentHash: archiveHash, bytes: zip.length },
    })
    await savePlan(interrupted, paths.state)
    const resumed = await applyPlan(interrupted, { id: interrupted.id, revision: interrupted.revision, digest: interrupted.digest }, paths.state)
    expect(resumed.artifacts[0]?.status).toBe('applied')
    expect((await loadPlan(plan.id, paths.state)).archiveState).toMatchObject({ status: 'applied', contentHash: archiveHash, bytes: zip.length })
    expect(resumed.deliverables.archive).toBe('bundle.zip')
  })

  it('creates byte-identical streamed ZIPs for identical reviewed outputs', async () => {
    const paths = await fixture({ 'one.txt': 'one', 'two.txt': 'two' })
    const recipe = { ...defaultRecipeV2('deterministic archive'), archive: { kind: 'zip' as const, destination: 'bundle.zip' } }
    const first = await createPlan({ sourceRoot: paths.source, destinationRoot: paths.output, recipe })
    await savePlan(first, paths.state)
    await applyPlan(first, { id: first.id, revision: first.revision, digest: first.digest }, paths.state)
    const secondOutput = join(paths.root, 'second-output')
    const second = await createPlan({ sourceRoot: paths.source, destinationRoot: secondOutput, recipe })
    await savePlan(second, paths.state)
    await applyPlan(second, { id: second.id, revision: second.revision, digest: second.digest }, paths.state)
    expect(await readFile(join(secondOutput, 'bundle.zip'))).toEqual(await readFile(join(paths.output, 'bundle.zip')))
  })

  it('does not adopt an unrelated pre-existing archive without a prior intent', async () => {
    const paths = await fixture({ 'one.txt': 'one' })
    const recipe = { ...defaultRecipeV2('archive collision'), archive: { kind: 'zip' as const, destination: 'bundle.zip' } }
    const plan = await createPlan({ sourceRoot: paths.source, destinationRoot: paths.output, recipe })
    await mkdir(paths.output, { recursive: true })
    await writeFile(join(paths.output, 'bundle.zip'), 'unrelated', 'utf8')
    await savePlan(plan, paths.state)
    const result = await applyPlan(plan, { id: plan.id, revision: plan.revision, digest: plan.digest }, paths.state)
    expect((await loadPlan(plan.id, paths.state)).archiveState).toMatchObject({ status: 'failed' })
    expect(result.deliverables.archive).toBeUndefined()
    expect(await readFile(join(paths.output, 'bundle.zip'), 'utf8')).toBe('unrelated')
  })

  it('serializes independent callers through the durable state lock', async () => {
    const paths = await fixture({ 'one.txt': 'one' })
    let active = 0; let peak = 0; const order: string[] = []
    await Promise.all(['a', 'b'].map(label => withStateLock(paths.state, 'same-plan', async () => {
      active++; peak = Math.max(peak, active); order.push(`${label}:start`)
      await new Promise(resolveWait => setTimeout(resolveWait, 40))
      order.push(`${label}:end`); active--
    })))
    expect(peak).toBe(1)
    expect(order).toEqual(expect.arrayContaining(['a:start', 'a:end', 'b:start', 'b:end']))
    expect(Math.abs(order.indexOf('a:start') - order.indexOf('a:end'))).toBe(1)
    expect(Math.abs(order.indexOf('b:start') - order.indexOf('b:end'))).toBe(1)
  })

  it('reclaims a lock whose owner died before publishing its owner record', async () => {
    const paths = await fixture({ 'one.txt': 'one' })
    const id = createHash('sha256').update('abandoned-plan').digest('hex').slice(0, 40)
    const lock = join(paths.state, 'locks', `${id}.lock`)
    await mkdir(lock, { recursive: true })
    // Backdate the directory: a real orphan is only reclaimed after the grace period.
    const past = new Date(Date.now() - 60_000)
    await utimes(lock, past, past)
    const result = await withStateLock(paths.state, 'abandoned-plan', async () => 'ran')
    expect(result).toBe('ran')
    await expect(readFile(join(lock, 'owner.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('never steals a lock held by a live process on this host', async () => {
    const paths = await fixture({ 'one.txt': 'one' })
    const id = createHash('sha256').update('busy-plan').digest('hex').slice(0, 40)
    const lock = join(paths.state, 'locks', `${id}.lock`)
    await mkdir(lock, { recursive: true })
    await writeFile(join(lock, 'owner.json'), `${JSON.stringify({ token: 'peer', pid: process.pid, host: hostname() })}\n`, 'utf8')
    await expect(withStateLock(paths.state, 'busy-plan', async () => 'ran')).rejects.toThrow('still modifying')
    // The peer's lock survived, so mutual exclusion was never broken.
    expect(JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')).token).toBe('peer')
  }, 20_000)

  it('does not turn index template proposals into saved overrides', async () => {
    const paths = await fixture({ 'one.txt': '1', 'two.txt': '2' }); const recipe = { ...defaultRecipe('numbers'), pattern: 'copy-{index}' }
    const plan = await createPlan({ sourceRoot: paths.source, destinationRoot: paths.output, recipe }); const saved = recipeFromPlan(plan, 'numbers saved')
    expect(saved.overrides).toBeUndefined()
    const next = await fixture({ 'three.txt': '3' }); const reused = await createPlan({ sourceRoot: next.source, destinationRoot: next.output, recipe: saved })
    expect(reused.items[0]!.destination).toBe(join('text', 'copy-1.txt'))
    const overridden = { ...saved, overrides: { 'three.txt': join('text', 'custom.txt') } }
    const loaded = await createPlan({ sourceRoot: next.source, destinationRoot: join(next.root, 'other-output'), recipe: overridden })
    const reverted = revisePlan(loaded, [{ id: loaded.items[0]!.id, destination: 'text/copy-1.txt' }])
    expect(recipeFromPlan(reverted, 'without custom name').overrides).toBeUndefined()
  })

  it('serializes concurrent loopback mutations and rejects stale apply identities', async () => {
    const paths = await fixture({ 'notes.txt': 'note' }); const server = await startLocalWorkbench({ sourceRoot: paths.source, destinationRoot: paths.output, stateRoot: paths.state })
    try {
      const plan = (await (await fetch(`${server.url}/api/plan`)).json()).plan
      const headers = { 'content-type': 'application/json', 'x-dsh-csrf': server.csrfToken, origin: server.url }
      const [apply, revise] = await Promise.all([
        fetch(`${server.url}/api/apply`, { method: 'POST', headers, body: JSON.stringify({ revision: plan.revision, digest: plan.digest }) }),
        fetch(`${server.url}/api/revise`, { method: 'POST', headers, body: JSON.stringify({ revision: plan.revision, edits: [{ id: plan.items[0].id, destination: 'text/renamed.txt' }] }) }),
      ])
      expect([apply.status, revise.status].sort()).toEqual([200, 409])
      const finalPlan = await loadPlan(plan.id, paths.state); expect(finalPlan.items[0]!.status).toBe('applied')
    } finally { await server.close() }
  })
})

describe('recipe v2 proposals', () => {
  it('renders a nested destination from a named RE2 capture', async () => {
    const paths = await fixture({ 'ABC-42_description.pdf': 'pdf' })
    const recipe = {
      ...defaultRecipeV2('captured code'),
      pattern: 'PRO/PRO_FILES/{match.code}/{match.code}.pdf',
      classification: { kind: 'none' as const },
      match: { regex: '^(?<code>[^_]+)_.*\\.pdf$', scope: 'basename' as const, flags: 'u' },
    }
    const plan = await createPlan({ sourceRoot: paths.source, destinationRoot: paths.output, recipe })
    expect(plan.items[0]).toMatchObject({
      destination: join('PRO', 'PRO_FILES', 'ABC-42', 'ABC-42.pdf'),
      proposalDisposition: 'ready', captures: { code: 'ABC-42' },
    })
    expect(plan.summary).toMatchObject({ total: 1, ready: 1, exception: 0 })
    expect(plan.diagnostics).toMatchObject({ ready: 1, exceptions: 0, artifactCount: 0 })
  })

  it('surfaces unmatched and unsafe captures, then permits a safe reviewed override', async () => {
    const paths = await fixture({ 'CON_report.pdf': 'reserved', 'plain.pdf': 'unmatched' })
    const recipe = {
      ...defaultRecipeV2('exceptions'), pattern: '{match.code}.pdf', classification: { kind: 'none' as const },
      match: { regex: '^(?<code>[^_]+)_.*\\.pdf$', scope: 'basename' as const, flags: 'u' },
    }
    const plan = await createPlan({ sourceRoot: paths.source, destinationRoot: paths.output, recipe })
    expect(plan.items.map(item => [item.relativePath, item.exceptionCode])).toEqual([
      ['CON_report.pdf', 'unsafe-capture'], ['plain.pdf', 'unmatched'],
    ])
    expect(plan.summary).toMatchObject({ ready: 0, exception: 2 })
    expect(plan.diagnostics.exceptionsByReason).toEqual({ unmatched: 1, 'unsafe-capture': 1 })
    await savePlan(plan, paths.state)
    // Reviewed exceptions never block the copyable items and never write anything.
    const applied = await applyPlan(plan, { id: plan.id, revision: plan.revision, digest: plan.digest }, paths.state)
    expect(applied.summary).toMatchObject({ applied: 0, exception: 2 })
    await expect(readFile(join(paths.output, 'plain.pdf'))).rejects.toMatchObject({ code: 'ENOENT' })

    const unmatched = plan.items.find(item => item.exceptionCode === 'unmatched')!
    expect(() => revisePlan(plan, [{ id: unmatched.id, destination: '../plain.pdf' }])).toThrow('escapes its output folder')
    expect(() => revisePlan(plan, [{ id: unmatched.id, destination: 'manual/plain.txt' }])).toThrow('original .pdf extension')
    const revised = revisePlan(plan, [{ id: unmatched.id, destination: 'manual/plain.pdf' }])
    expect(revised.items.find(item => item.id === unmatched.id)).toMatchObject({ destination: join('manual', 'plain.pdf'), proposalDisposition: 'ready' })
    expect(revised.items.find(item => item.id === unmatched.id)?.exceptionCode).toBeUndefined()
    expect(revised.summary).toMatchObject({ ready: 1, exception: 1 })
  })

  it('marks exact, case-insensitive, and ancestor destination collisions as exceptions', async () => {
    const paths = await fixture({ 'ancestor': 'a', 'child.txt': 'b', 'exact-1.txt': 'c', 'exact-2.txt': 'd', 'case-1.txt': 'e', 'case-2.txt': 'f' })
    const recipe = {
      ...defaultRecipeV2('collisions'), classification: { kind: 'none' as const },
      overrides: {
        ancestor: 'Node', 'child.txt': join('node', 'child.txt'),
        'exact-1.txt': 'same.txt', 'exact-2.txt': 'same.txt',
        'case-1.txt': 'Case.txt', 'case-2.txt': 'case.txt',
      },
    }
    const plan = await createPlan({ sourceRoot: paths.source, destinationRoot: paths.output, recipe })
    expect(plan.items).toHaveLength(6)
    expect(plan.items.every(item => item.proposalDisposition === 'exception' && item.exceptionCode === 'collision')).toBe(true)
    expect(plan.summary).toMatchObject({ ready: 0, exception: 6 })
    expect(plan.diagnostics).toMatchObject({ collisions: 6, exceptions: 6 })

    const child = plan.items.find(item => item.relativePath === 'child.txt')!
    const revised = revisePlan(plan, [{ id: child.id, destination: 'elsewhere/child.txt' }])
    expect(revised.items.find(item => item.relativePath === 'child.txt')?.proposalDisposition).toBe('ready')
    expect(revised.items.find(item => item.relativePath === 'ancestor')?.proposalDisposition).toBe('ready')
    expect(revised.diagnostics.collisions).toBe(4)
  })

  it('keeps digest generation deterministic and binds reviewed proposal metadata', async () => {
    const paths = await fixture({ 'AA-BB_report.pdf': 'pdf' })
    const recipe = {
      ...defaultRecipeV2('digest'), pattern: '{match.left}/{match.right}.pdf', classification: { kind: 'none' as const },
      match: { regex: '^(?<left>[^-]+)-(?<right>[^_]+)_.*\\.pdf$', scope: 'basename' as const, flags: 'u' },
    }
    const plan = await createPlan({ sourceRoot: paths.source, destinationRoot: paths.output, recipe })
    const reversedCaptures = { right: 'BB', left: 'AA' }
    const same = withDigest({ ...plan, items: [{ ...plan.items[0]!, captures: reversedCaptures }] })
    expect(same.digest).toBe(plan.digest)
    const applied = withDigest({ ...plan, items: [{ ...plan.items[0]!, status: 'applied' as const }] })
    expect(applied.digest).toBe(plan.digest)
    const changedCapture = withDigest({ ...plan, items: [{ ...plan.items[0]!, captures: { left: 'ZZ', right: 'BB' } }] })
    expect(changedCapture.digest).not.toBe(plan.digest)
    const changedDisposition = withDigest({ ...plan, items: [{ ...plan.items[0]!, proposalDisposition: 'exception' as const, exceptionCode: 'collision' as const }] })
    expect(changedDisposition.digest).not.toBe(plan.digest)
  })

  it('preserves v1 flat-template destinations and fail-fast collisions', async () => {
    const paths = await fixture({ 'one.txt': '1', 'nested/two.md': '2' })
    const recipe = { ...defaultRecipe('legacy'), pattern: '{index}-{stem}-{class}' }
    const plan = await createPlan({ sourceRoot: paths.source, destinationRoot: paths.output, recipe })
    expect(plan.items.map(item => item.destination)).toEqual([join('text', '1-two-text.md'), join('text', '2-one-text.txt')])
    expect(plan.items.every(item => item.proposalDisposition === 'ready')).toBe(true)
    expect(plan.digest).toBe(stableDigest({
      version: plan.version, id: plan.id, revision: plan.revision, createdAt: plan.createdAt,
      sourceRoot: plan.sourceRoot, destinationRoot: plan.destinationRoot, recipe: plan.recipe,
      items: plan.items.map(item => ({ id: item.id, source: item.source, relativePath: item.relativePath, destination: item.destination, sourceHash: item.sourceHash, classification: item.classification })),
      artifacts: [],
    }))

    const collisionRecipe = { ...defaultRecipe('legacy collision'), pattern: 'same', classification: { kind: 'none' as const } }
    const collisionPaths = await fixture({ 'a.txt': 'a', 'b.txt': 'b' })
    await expect(createPlan({ sourceRoot: collisionPaths.source, destinationRoot: collisionPaths.output, recipe: collisionRecipe })).rejects.toThrow('same destination')
  })

  it('rerenders reviewed sidecars and resets the archive when one destination is revised', async () => {
    const paths = await fixture({ 'one.txt': "O'Brien 世界" })
    const recipe = {
      ...defaultRecipeV2('sidecar revision'), classification: { kind: 'none' as const },
      sidecars: [
        { kind: 'manifest' as const, destination: 'review.json', format: 'json' as const },
        { kind: 'checksums' as const, destination: 'SHA256SUMS.txt' },
        { kind: 'sql-insert' as const, destination: 'init.sql', sql: { dialect: 'postgres' as const, schema: 'public', table: 'files', columns: ['NAME'], values: { NAME: '{stem}' } } },
      ],
      archive: { kind: 'zip' as const, destination: 'bundle.zip' },
    }
    const plan = await createPlan({ sourceRoot: paths.source, destinationRoot: paths.output, recipe })
    const priorHashes = plan.artifacts.map(artifact => artifact.contentHash)
    const revised = revisePlan(plan, [{ id: plan.items[0]!.id, destination: 'nested/renamed.txt' }])
    expect(revised.revision).toBe(2)
    expect(revised.artifacts.map(artifact => artifact.contentHash)).not.toEqual(priorHashes)
    expect(revised.archiveState).toEqual({ status: 'ready' })
    await savePlan(revised, paths.state)
    const applied = await applyPlan(revised, { id: revised.id, revision: revised.revision, digest: revised.digest }, paths.state)
    expect(applied.artifacts.every(artifact => artifact.status === 'applied')).toBe(true)
    expect(applied.deliverables.archive).toBe('bundle.zip')
    expect(await readFile(join(paths.output, 'init.sql'), 'utf8')).toContain("('one');")
  })

  it('applies a legacy plan whose items carry no disposition field and reports its deliverables', async () => {
    const paths = await fixture({ 'one.txt': 'legacy bytes' })
    const bytes = 'legacy bytes'
    // A plan written by 0.1 stored canonical roots: createPlan ran realpath over
    // both the source root and every discovered source file. A Windows temp path
    // can contain an 8.3 short component, so the fixture must canonicalise too.
    const sourceRoot = await realpath(paths.source)
    const source = await realpath(join(paths.source, 'one.txt'))
    const legacy = withDigest({
      version: 'm0', id: '33333333-3333-4333-8333-333333333333', revision: 1, createdAt: '2025-01-02T03:04:05.000Z',
      sourceRoot, destinationRoot: await canonicalPath(paths.output),
      recipe: { version: 1, id: '11111111-1111-4111-8111-111111111111', name: 'Legacy rule', createdAt: '2025-01-02T03:04:05.000Z', pattern: '{stem}', classification: { kind: 'folder-prefix' } },
      items: [{
        id: '0123456789abcdef', source, relativePath: 'one.txt',
        destination: join('text', 'one.txt'), sourceHash: createHash('sha256').update(bytes).digest('hex'),
        classification: 'text', status: 'ready',
      }],
    } as unknown as Plan)
    await savePlan(legacy, paths.state)
    const result = await applyPlan(legacy, { id: legacy.id, revision: legacy.revision, digest: legacy.digest }, paths.state)
    expect(result.summary.applied).toBe(1)
    // A pre-0.2 item has no disposition field, so it must never be filtered out of the deliverables.
    expect(result.deliverables.files).toEqual([join('text', 'one.txt')])
    expect(await readFile(join(paths.output, 'text', 'one.txt'), 'utf8')).toBe(bytes)
  })

  it('loads a golden persisted 0.1 plan without reinterpreting its digest', async () => {
    const paths = await fixture({ 'placeholder.txt': 'x' })
    const id = '22222222-2222-4222-8222-222222222222'
    await mkdir(join(paths.state, 'plans'), { recursive: true })
    await cp(join(process.cwd(), 'tests', 'fixtures', 'v01-plan.json'), join(paths.state, 'plans', `${id}.json`))
    const legacy = await loadPlan(id, paths.state)
    expect(legacy.digest).toBe('fb1db1a3c71713aadbcacd305e4729a2986c4e31845c8c8da7cd9668b30a894a')
    expect(legacy.recipe.version).toBe(1)
    expect(legacy.artifacts).toBeUndefined()
    expect(legacy.items[0]!.destination.replace(/\\/g, '/')).toBe('text/one.txt')
    await mkdir(join(paths.state, 'recipes'), { recursive: true })
    await cp(join(process.cwd(), 'tests', 'fixtures', 'v01-recipe.json'), join(paths.state, 'recipes', '11111111-1111-4111-8111-111111111111.json'))
    expect(await loadRecipe('11111111-1111-4111-8111-111111111111', paths.state)).toMatchObject({ version: 1, pattern: '{stem}' })
  })

  it('rejects nested-quantifier ReDoS expressions before matching', () => {
    const recipe = {
      ...defaultRecipeV2('unsafe regex'),
      match: { regex: '^(?<code>a+)+$', scope: 'basename' as const, flags: 'u' },
    }
    expect(() => validateRecipe(recipe)).toThrow('cannot quantify a capture group')
  })
})
