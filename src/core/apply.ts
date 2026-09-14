import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, realpath, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { assertNoCollisions, assertPlanShape, samePath, sha256, summarize, within, withDigest } from './plan.js'
import { safeRelative } from './recipe.js'
import { loadPlan, savePlan } from './storage.js'
import type { ApplyResult, Plan, PlanItem } from './types.js'

export interface ApplyExpectation { id: string; revision: number; digest: string }
const planLocks = new Map<string, Promise<void>>()

/** Applies only the exact reviewed identity. Each durable status follows the disk operation it records. */
export async function applyPlan(submitted: Plan, expected: ApplyExpectation, stateRoot: string): Promise<ApplyResult> {
  return await withPlanLock(expected.id, async () => {
    assertPlanShape(submitted)
    if (submitted.id !== expected.id || submitted.revision !== expected.revision || submitted.digest !== expected.digest) throw new Error('Apply must name the exact reviewed plan')
    const persisted = await loadPlan(expected.id, stateRoot)
    if (persisted.revision !== expected.revision || persisted.digest !== expected.digest) throw new Error('Plan changed after review; refresh the preview')
    assertNoCollisions(persisted.items)
    const sourceRoot = await realpath(persisted.sourceRoot)
    if (!samePath(sourceRoot, persisted.sourceRoot)) throw new Error('Source root changed after preview')
    const destinationRoot = await prepareDestinationRoot(persisted.destinationRoot)
    let current = persisted
    for (const item of current.items) {
      if (item.status === 'applied') { await assertCompletedItem(item, destinationRoot); continue }
      if (item.status !== 'ready') continue
      const outcome = await applyItem(item, sourceRoot, destinationRoot)
      const items = current.items.map(candidate => candidate.id === item.id ? outcome : candidate)
      current = withDigest({ ...current, digest: '', items, summary: summarize(items) })
      await savePlan(current, stateRoot)
    }
    return { planId: current.id, revision: current.revision, digest: current.digest, items: current.items, summary: current.summary }
  })
}

async function applyItem(item: PlanItem, sourceRoot: string, destinationRoot: string): Promise<PlanItem> {
  try {
    const source = await safeExistingSource(item.source, sourceRoot)
    if (await sha256(source) !== item.sourceHash) return { ...item, status: 'rejected', reason: '來源檔案在預覽後已變更，未建立副本。' }
    const destination = await safeOutput(item.destination, destinationRoot)
    if (await exists(destination)) return { ...item, status: 'failed', reason: '目的地已存在；為了避免覆寫，未建立副本。若這是中斷前的副本，請先檢查它。' }
    const temporary = join(dirname(destination), `.dsh-ditto-${item.id}-${randomUUID()}.tmp`)
    try {
      await copyFile(source, temporary, constants.COPYFILE_EXCL)
      const sourceAfter = await sha256(source)
      const temporaryHash = await sha256(temporary)
      if (sourceAfter !== item.sourceHash || temporaryHash !== item.sourceHash) return { ...item, status: 'rejected', reason: '複製期間來源變更或輸出驗證失敗，未建立副本。' }
      await copyFile(temporary, destination, constants.COPYFILE_EXCL)
      if (await sha256(destination) !== item.sourceHash) return { ...item, status: 'failed', reason: '輸出驗證失敗；請檢查目的地後再繼續。' }
      return { ...item, status: 'applied' }
    } finally { await rm(temporary, { force: true }).catch(() => undefined) }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown copy failure'
    return { ...item, status: 'failed', reason: message.slice(0, 300) }
  }
}

async function safeExistingSource(source: string, sourceRoot: string): Promise<string> {
  const resolved = await realpath(source)
  if (!samePath(resolved, source) || !within(sourceRoot, resolved)) throw new Error('Source path escaped the reviewed folder')
  const details = await lstat(resolved)
  if (!details.isFile() || details.isSymbolicLink()) throw new Error('Source is no longer a regular file')
  return resolved
}

async function prepareDestinationRoot(root: string): Promise<string> {
  const expected = resolve(root)
  await assertExistingAncestorsAreReal(expected)
  await mkdir(expected, { recursive: true })
  const actual = await realpath(expected)
  const details = await lstat(expected)
  if (!details.isDirectory() || details.isSymbolicLink() || !samePath(actual, expected)) throw new Error('Output root is a symlink, junction, or non-directory')
  return actual
}

async function assertExistingAncestorsAreReal(target: string): Promise<void> {
  let cursor = target
  while (true) {
    try {
      const details = await lstat(cursor)
      const actual = await realpath(cursor)
      if (!details.isDirectory() || details.isSymbolicLink() || !samePath(actual, cursor)) throw new Error('Output root has a symlink or junction ancestor')
      return
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(cursor)
      if (parent === cursor) throw new Error('Output root has no accessible parent')
      cursor = parent
    }
  }
}

async function safeOutput(destination: string, destinationRoot: string): Promise<string> {
  const relativeDestination = safeRelative(destination)
  const target = resolve(destinationRoot, relativeDestination)
  if (!within(destinationRoot, target)) throw new Error('Destination escaped the output folder')
  let cursor = destinationRoot
  const parts = relativeDestination.split(/[\\/]/)
  for (const segment of parts.slice(0, -1)) {
    cursor = join(cursor, segment)
    await mkdir(cursor, { recursive: false }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
    const details = await lstat(cursor)
    const actual = await realpath(cursor)
    if (!details.isDirectory() || details.isSymbolicLink() || !within(destinationRoot, actual)) throw new Error('Destination folder is a symlink, junction, or non-directory')
  }
  return target
}

async function assertCompletedItem(item: PlanItem, destinationRoot: string): Promise<void> {
  const target = await safeOutput(item.destination, destinationRoot)
  const details = await lstat(target)
  if (!details.isFile() || details.isSymbolicLink() || await sha256(target) !== item.sourceHash) throw new Error(`Previously applied output is missing or changed: ${item.destination}`)
}

async function exists(path: string): Promise<boolean> { try { await lstat(path); return true } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } }

async function withPlanLock<T>(id: string, work: () => Promise<T>): Promise<T> {
  const previous = planLocks.get(id) ?? Promise.resolve()
  let release!: () => void
  const queued = new Promise<void>(resolveRelease => { release = resolveRelease })
  const tail = previous.then(() => queued)
  planLocks.set(id, tail)
  await previous
  try { return await work() } finally { release(); if (planLocks.get(id) === tail) planLocks.delete(id) }
}
