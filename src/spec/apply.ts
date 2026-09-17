import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { safeRelative } from '../core/recipe.js'
import { assertNoLinkAncestor, samePath, within } from '../core/paths.js'
import { assertSpecBatch } from './generate.js'
import { hash, summarizeSpecItems, withSpecDigest } from './prepare.js'
import { loadSpecBatch, saveSpecBatch } from './storage.js'
import type { SpecApplyExpectation, SpecApplyResult, SpecBatch, SpecModule } from './types.js'

const locks = new Map<string, Promise<void>>()

/** A batch is writable only when every discovered module has a complete reviewed preview. */
export function isSpecBatchReadyToApply(batch: Pick<SpecBatch, 'items'>): boolean {
  return batch.items.length > 0 && batch.items.every(item =>
    ['approved', 'ready', 'applied'].includes(item.status)
    && Boolean(item.renderedMarkdown)
    && Boolean(item.renderedHash)
    && hash(item.renderedMarkdown!) === item.renderedHash,
  )
}

/** Writes only reviewed Markdown to a separate, verified output root. Resume validates every recorded output. */
export async function applySpecBatch(submitted: SpecBatch, expected: SpecApplyExpectation, stateRoot: string): Promise<SpecApplyResult> {
  return withLock(expected.id, async () => {
    assertSpecBatch(submitted)
    if (submitted.id !== expected.id || submitted.revision !== expected.revision || submitted.digest !== expected.digest) throw new Error('Apply must name the exact reviewed batch (id, revision, and digest)')
    if (!isSpecBatchReadyToApply(submitted)) throw new Error('The full batch preview is not complete; specifications cannot be written yet')
    const persisted = await loadSpecBatch(expected.id, stateRoot)
    if (persisted.revision !== expected.revision || persisted.digest !== expected.digest) throw new Error('The batch changed after review; refresh the preview and confirm again')
    if (!isSpecBatchReadyToApply(persisted)) throw new Error('The full batch preview is not complete; specifications cannot be written yet')
    const sourceRoot = await realpath(persisted.sourceRoot)
    if (!samePath(sourceRoot, persisted.sourceRoot)) throw new Error('The source folder changed after the preview')
    await preflight(persisted, sourceRoot)
    const outputRoot = await prepareOutputRoot(persisted.outputRoot)
    let current = persisted
    for (const item of current.items) {
      if (item.status === 'applied') { await assertCompleted(item, outputRoot); continue }
      if (!['ready', 'approved'].includes(item.status)) continue
      const outcome = await applyOne(item, sourceRoot, outputRoot)
      const items = current.items.map(candidate => candidate.id === item.id ? outcome : candidate)
      current = withSpecDigest({ ...current, digest: '', items, summary: summarizeSpecItems(items) })
      await saveSpecBatch(current, stateRoot)
    }
    return { batchId: current.id, revision: current.revision, digest: current.digest, items: current.items, summary: current.summary }
  })
}

async function applyOne(item: SpecModule, sourceRoot: string, outputRoot: string): Promise<SpecModule> {
  try {
    if (!item.renderedMarkdown || !item.renderedHash || hash(item.renderedMarkdown) !== item.renderedHash) return { ...item, status: 'needs-review', reason: 'No validated Markdown specification exists for this module' }
    const source = await safeSource(item.source, sourceRoot)
    if (hash(await readFile(source)) !== item.sourceHash) return { ...item, status: 'rejected', reason: 'The source file changed after the preview; the specification was not written' }
    const output = await safeOutput(item.outputPath, outputRoot)
    if (await exists(output)) return { ...item, status: 'failed', reason: 'The specification destination already exists; nothing was written to avoid overwriting it' }
    const temporary = join(dirname(output), `.dsh-ditto-spec-${item.id}-${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, item.renderedMarkdown, { encoding: 'utf8', flag: 'wx' })
      if (hash(await readFile(temporary, 'utf8')) !== item.renderedHash || hash(await readFile(source)) !== item.sourceHash) return { ...item, status: 'rejected', reason: 'The source or the specification failed verification during the write; nothing was written' }
      await copyFile(temporary, output, constants.COPYFILE_EXCL)
      if (hash(await readFile(output, 'utf8')) !== item.renderedHash) { await rm(output, { force: true }); return { ...item, status: 'failed', reason: 'Output verification failed; the invalid output was removed' } }
      return { ...item, status: 'applied', reason: undefined }
    } finally { await rm(temporary, { force: true }).catch(() => undefined) }
  } catch (error: unknown) { return { ...item, status: 'failed', reason: (error instanceof Error ? error.message : 'Writing the specification failed').slice(0, 300) } }
}
async function safeSource(source: string, root: string): Promise<string> { const actual = await realpath(source); const info = await lstat(actual); if (!samePath(actual, source) || !within(root, actual) || !info.isFile() || info.isSymbolicLink()) throw new Error('The source file left the reviewed scope'); return actual }
/** This stage has no mkdir/write operations: an invalid later item cannot leave earlier specs behind. */
async function preflight(batch: SpecBatch, sourceRoot: string): Promise<void> {
  await assertRealAncestor(resolve(batch.outputRoot))
  for (const item of batch.items) {
    if (item.status === 'applied') { await assertCompletedWithoutMutation(item, resolve(batch.outputRoot)); continue }
    if (!['ready', 'approved'].includes(item.status)) continue
    if (!item.renderedMarkdown || !item.renderedHash || hash(item.renderedMarkdown) !== item.renderedHash) throw new Error(`Specification not reviewed: ${item.relativePath}`)
    const source = await safeSource(item.source, sourceRoot)
    if (hash(await readFile(source)) !== item.sourceHash) throw new Error(`The source file changed after the preview: ${item.relativePath}`)
    await assertAvailableOutput(item.outputPath, resolve(batch.outputRoot))
  }
}
async function assertAvailableOutput(relativePath: string, root: string): Promise<void> {
  const safe = safeRelative(relativePath); const target = resolve(root, safe); if (!within(root, target)) throw new Error('The specification destination escapes the output folder')
  if (await exists(target)) throw new Error(`The specification destination already exists: ${relativePath}`)
  let cursor = root
  for (const segment of safe.split(/[\\/]/).slice(0, -1)) {
    cursor = join(cursor, segment)
    try { const info = await lstat(cursor); const actual = await realpath(cursor); if (!info.isDirectory() || info.isSymbolicLink() || !within(root, actual, true)) throw new Error('The specification destination has a symlink or junction folder') } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error }
  }
}
async function assertCompletedWithoutMutation(item: SpecModule, root: string): Promise<void> { if (!item.renderedHash) throw new Error('A completed item has no specification hash'); const safe = safeRelative(item.outputPath); const output = resolve(root, safe); if (!within(root, output)) throw new Error('The specification destination escapes the output folder'); const info = await lstat(output); if (!info.isFile() || info.isSymbolicLink() || hash(await readFile(output, 'utf8')) !== item.renderedHash) throw new Error(`A previously written specification is missing or changed: ${item.outputPath}`) }
async function prepareOutputRoot(root: string): Promise<string> { const expected = resolve(root); await assertRealAncestor(expected); await mkdir(expected, { recursive: true }); const info = await lstat(expected); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The specification output folder is a symlink, junction, or not a directory'); return await realpath(expected) }
async function assertRealAncestor(target: string): Promise<void> { await assertNoLinkAncestor(target, 'The specification output folder has a symlink or junction ancestor') }
async function safeOutput(relativePath: string, root: string): Promise<string> { const safe = safeRelative(relativePath); const target = resolve(root, safe); if (!within(root, target)) throw new Error('The specification destination escapes the output folder'); let cursor = root; for (const segment of safe.split(/[\\/]/).slice(0, -1)) { cursor = join(cursor, segment); await mkdir(cursor, { recursive: false }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }); const info = await lstat(cursor); const actual = await realpath(cursor); if (!info.isDirectory() || info.isSymbolicLink() || !within(root, actual, true)) throw new Error('The specification destination has a symlink or junction folder') } return target }
async function assertCompleted(item: SpecModule, root: string): Promise<void> { if (!item.renderedHash) throw new Error('A completed item has no specification hash'); const output = await safeOutput(item.outputPath, root); const info = await lstat(output); if (!info.isFile() || info.isSymbolicLink() || hash(await readFile(output, 'utf8')) !== item.renderedHash) throw new Error(`A previously written specification is missing or changed: ${item.outputPath}`) }
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } }
async function withLock<T>(id: string, action: () => Promise<T>): Promise<T> { const previous = locks.get(id) ?? Promise.resolve(); let release!: () => void; const tail = previous.then(() => new Promise<void>(resolveRelease => { release = resolveRelease })); locks.set(id, tail); await previous; try { return await action() } finally { release(); if (locks.get(id) === tail) locks.delete(id) } }
