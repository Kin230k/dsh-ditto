import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyPlan, createPlan, defaultRecipe, loadPlan, recipeFromPlan, revisePlan, safeRelative, savePlan, within } from '../../src/core/index.js'
import { startLocalWorkbench } from '../../src/server.js'

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

  it('keeps extensionless names and dotfiles intact, including below dotted folders', async () => {
    const paths = await fixture({ 'archive.v1/README': 'read me', '.keep': 'keep' })
    const plan = await createPlan({ sourceRoot: paths.source, destinationRoot: paths.output, recipe: defaultRecipe() })
    expect(plan.items.map(item => item.destination).sort()).toEqual([join('other', '.keep'), join('other', 'README')])
    await savePlan(plan, paths.state)
    await applyPlan(plan, { id: plan.id, revision: plan.revision, digest: plan.digest }, paths.state)
    expect(await readFile(join(paths.output, 'other', 'README'), 'utf8')).toBe('read me')
    expect(await readFile(join(paths.output, 'other', '.keep'), 'utf8')).toBe('keep')
  })

  it('rejects an output-root junction before it can create files through it', async () => {
    if (process.platform !== 'win32') return
    const paths = await fixture({ 'notes.txt': 'note' }); const outside = join(paths.root, 'outside'); const junction = join(paths.root, 'output-link')
    await mkdir(outside); await symlink(outside, junction, 'junction')
    const plan = await createPlan({ sourceRoot: paths.source, destinationRoot: join(junction, 'new-output'), recipe: defaultRecipe() }); await savePlan(plan, paths.state)
    await expect(applyPlan(plan, { id: plan.id, revision: plan.revision, digest: plan.digest }, paths.state)).rejects.toThrow('symlink or junction ancestor')
    await expect(readFile(join(outside, 'new-output', 'text', 'notes.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
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
