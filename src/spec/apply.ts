import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { safeRelative } from '../core/recipe.js'
import { samePath, within } from '../core/plan.js'
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
    if (submitted.id !== expected.id || submitted.revision !== expected.revision || submitted.digest !== expected.digest) throw new Error('寫入必須使用已檢視的確切批次')
    if (!isSpecBatchReadyToApply(submitted)) throw new Error('完整批次預覽尚未完成，不能寫入規格')
    const persisted = await loadSpecBatch(expected.id, stateRoot)
    if (persisted.revision !== expected.revision || persisted.digest !== expected.digest) throw new Error('檢視已變更，請重新確認')
    if (!isSpecBatchReadyToApply(persisted)) throw new Error('完整批次預覽尚未完成，不能寫入規格')
    const sourceRoot = await realpath(persisted.sourceRoot)
    if (!samePath(sourceRoot, persisted.sourceRoot)) throw new Error('來源資料夾在預覽後變更')
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
    if (!item.renderedMarkdown || !item.renderedHash || hash(item.renderedMarkdown) !== item.renderedHash) return { ...item, status: 'needs-review', reason: '尚未有通過驗證的 Markdown 規格' }
    const source = await safeSource(item.source, sourceRoot)
    if (hash(await readFile(source)) !== item.sourceHash) return { ...item, status: 'rejected', reason: '來源檔案在預覽後已變更，未寫入規格' }
    const output = await safeOutput(item.outputPath, outputRoot)
    if (await exists(output)) return { ...item, status: 'failed', reason: '規格目的地已存在，為了避免覆寫而未寫入' }
    const temporary = join(dirname(output), `.dsh-ditto-spec-${item.id}-${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, item.renderedMarkdown, { encoding: 'utf8', flag: 'wx' })
      if (hash(await readFile(temporary, 'utf8')) !== item.renderedHash || hash(await readFile(source)) !== item.sourceHash) return { ...item, status: 'rejected', reason: '寫入期間來源或規格驗證失敗，未建立規格' }
      await copyFile(temporary, output, constants.COPYFILE_EXCL)
      if (hash(await readFile(output, 'utf8')) !== item.renderedHash) { await rm(output, { force: true }); return { ...item, status: 'failed', reason: '規格輸出驗證失敗，已移除不合格輸出' } }
      return { ...item, status: 'applied', reason: undefined }
    } finally { await rm(temporary, { force: true }).catch(() => undefined) }
  } catch (error: unknown) { return { ...item, status: 'failed', reason: (error instanceof Error ? error.message : '寫入規格失敗').slice(0, 300) } }
}
async function safeSource(source: string, root: string): Promise<string> { const actual = await realpath(source); const info = await lstat(actual); if (!samePath(actual, source) || !within(root, actual) || !info.isFile() || info.isSymbolicLink()) throw new Error('來源檔案已離開檢視範圍'); return actual }
/** This stage has no mkdir/write operations: an invalid later item cannot leave earlier specs behind. */
async function preflight(batch: SpecBatch, sourceRoot: string): Promise<void> {
  await assertRealAncestor(resolve(batch.outputRoot))
  for (const item of batch.items) {
    if (item.status === 'applied') { await assertCompletedWithoutMutation(item, resolve(batch.outputRoot)); continue }
    if (!['ready', 'approved'].includes(item.status)) continue
    if (!item.renderedMarkdown || !item.renderedHash || hash(item.renderedMarkdown) !== item.renderedHash) throw new Error(`規格未通過檢視：${item.relativePath}`)
    const source = await safeSource(item.source, sourceRoot)
    if (hash(await readFile(source)) !== item.sourceHash) throw new Error(`來源檔案在預覽後已變更：${item.relativePath}`)
    await assertAvailableOutput(item.outputPath, resolve(batch.outputRoot))
  }
}
async function assertAvailableOutput(relativePath: string, root: string): Promise<void> {
  const safe = safeRelative(relativePath); const target = resolve(root, safe); if (!within(root, target)) throw new Error('規格目的地離開輸出資料夾')
  if (await exists(target)) throw new Error(`規格目的地已存在：${relativePath}`)
  let cursor = root
  for (const segment of safe.split(/[\\/]/).slice(0, -1)) {
    cursor = join(cursor, segment)
    try { const info = await lstat(cursor); const actual = await realpath(cursor); if (!info.isDirectory() || info.isSymbolicLink() || !within(root, actual, true)) throw new Error('規格目的地有連結資料夾') } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error }
  }
}
async function assertCompletedWithoutMutation(item: SpecModule, root: string): Promise<void> { if (!item.renderedHash) throw new Error('已完成項目沒有規格摘要'); const safe = safeRelative(item.outputPath); const output = resolve(root, safe); if (!within(root, output)) throw new Error('規格目的地離開輸出資料夾'); const info = await lstat(output); if (!info.isFile() || info.isSymbolicLink() || hash(await readFile(output, 'utf8')) !== item.renderedHash) throw new Error(`已寫入的規格遺失或已變更：${item.outputPath}`) }
async function prepareOutputRoot(root: string): Promise<string> { const expected = resolve(root); await assertRealAncestor(expected); await mkdir(expected, { recursive: true }); const actual = await realpath(expected); const info = await lstat(expected); if (!info.isDirectory() || info.isSymbolicLink() || !samePath(actual, expected)) throw new Error('規格輸出資料夾是連結或不是資料夾'); return actual }
async function assertRealAncestor(target: string): Promise<void> { let cursor = target; while (true) { try { const info = await lstat(cursor); const actual = await realpath(cursor); if (!info.isDirectory() || info.isSymbolicLink() || !samePath(actual, cursor)) throw new Error('規格輸出資料夾有連結祖先'); return } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; const parent = dirname(cursor); if (parent === cursor) throw new Error('找不到可用的輸出資料夾祖先'); cursor = parent } } }
async function safeOutput(relativePath: string, root: string): Promise<string> { const safe = safeRelative(relativePath); const target = resolve(root, safe); if (!within(root, target)) throw new Error('規格目的地離開輸出資料夾'); let cursor = root; for (const segment of safe.split(/[\\/]/).slice(0, -1)) { cursor = join(cursor, segment); await mkdir(cursor, { recursive: false }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }); const info = await lstat(cursor); const actual = await realpath(cursor); if (!info.isDirectory() || info.isSymbolicLink() || !within(root, actual, true)) throw new Error('規格目的地有連結資料夾') } return target }
async function assertCompleted(item: SpecModule, root: string): Promise<void> { if (!item.renderedHash) throw new Error('已完成項目沒有規格摘要'); const output = await safeOutput(item.outputPath, root); const info = await lstat(output); if (!info.isFile() || info.isSymbolicLink() || hash(await readFile(output, 'utf8')) !== item.renderedHash) throw new Error(`已寫入的規格遺失或已變更：${item.outputPath}`) }
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } }
async function withLock<T>(id: string, action: () => Promise<T>): Promise<T> { const previous = locks.get(id) ?? Promise.resolve(); let release!: () => void; const tail = previous.then(() => new Promise<void>(resolveRelease => { release = resolveRelease })); locks.set(id, tail); await previous; try { return await action() } finally { release(); if (locks.get(id) === tail) locks.delete(id) } }
