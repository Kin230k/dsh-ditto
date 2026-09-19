import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { assertNoLinkAncestor, samePath, within } from './paths.js'

const CATEGORY = /^[a-z][a-z0-9-]{0,63}$/
const LEAF = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/

/**
 * Resolve one state category without ever following a linked state root or
 * category. The returned path is canonical and remains beneath stateRoot.
 */
export async function stateCategoryPath(stateRoot: string, category: string, create = false): Promise<string> {
  if (!CATEGORY.test(category)) throw new Error('Invalid state category')
  const root = resolve(stateRoot)
  await assertNoLinkAncestor(root, 'Ditto stateRoot has a symlink or junction ancestor')
  if (create) await mkdir(root, { recursive: true })
  await assertDirectory(root, root, 'Ditto stateRoot')

  const folder = resolve(root, category)
  if (!within(root, folder)) throw new Error('Invalid state path')
  await assertNoLinkAncestor(folder, 'Ditto state category has a symlink or junction ancestor')
  if (create) await mkdir(folder).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
  await assertDirectory(folder, root, 'Ditto state category')
  return folder
}

/** Read one regular, non-linked state leaf. */
export async function readStateText(stateRoot: string, category: string, leaf: string): Promise<string> {
  const file = await stateLeafPath(stateRoot, category, leaf, false)
  return readFile(file, 'utf8')
}

/** List a state category after link-checking the category itself. */
export async function listStateLeaves(stateRoot: string, category: string): Promise<string[]> {
  return readdir(await stateCategoryPath(stateRoot, category))
}

/** Atomically replace one regular state leaf without following linked leaves. */
export async function atomicWriteStateText(stateRoot: string, category: string, leaf: string, content: string): Promise<void> {
  const file = await stateLeafPath(stateRoot, category, leaf, true)
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' })
    await assertRegularLeaf(temporary, dirname(file), 'Temporary Ditto state file')
    // Recheck the category and destination immediately before replacement.
    await stateCategoryPath(stateRoot, category)
    await assertExistingLeafSafe(file, dirname(file))
    await rename(temporary, file)
    await assertRegularLeaf(file, dirname(file), 'Ditto state file')
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

/** How long a lock holder has to publish its owner record before it counts as an orphan. */
const ORPHAN_GRACE_MS = 2_000
const LOCK_WAIT_MS = 25
const LOCK_WAIT_ATTEMPTS = 200

/**
 * Cross-process mutation lock under stateRoot. Directory creation is atomic on
 * local filesystems. A lock left by a dead process on this host, or by a process
 * that died between `mkdir` and its owner write, is reclaimed; live or
 * remote-host locks fail closed instead of risking last-writer-wins.
 */
export async function withStateLock<T>(stateRoot: string, key: string, work: () => Promise<T>): Promise<T> {
  if (typeof key !== 'string' || key.length === 0 || key.length > 300) throw new Error('Invalid Ditto mutation lock key')
  const category = await stateCategoryPath(stateRoot, 'locks', true)
  const id = createHash('sha256').update(key).digest('hex').slice(0, 40)
  const lock = resolve(category, `${id}.lock`)
  const owner = resolve(lock, 'owner.json')
  const token = randomUUID()
  for (let attempt = 0; ; attempt++) {
    try {
      await mkdir(lock)
      break
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (await reclaimStaleLock(lock, owner)) continue
      if (attempt >= LOCK_WAIT_ATTEMPTS) throw new Error(`Another Ditto process is still modifying ${key}; retry after it finishes`)
      await new Promise(resolveWait => setTimeout(resolveWait, LOCK_WAIT_MS))
    }
  }
  let ownerWritten = false
  try {
    await writeFile(owner, `${JSON.stringify({ token, pid: process.pid, host: hostname(), startedAt: new Date().toISOString() })}\n`, { encoding: 'utf8', flag: 'wx' })
    ownerWritten = true
    await assertRegularLeaf(owner, lock, 'Ditto mutation lock owner')
    return await work()
  } finally {
    try {
      if (!ownerWritten) {
        const details = await lstat(lock)
        if (details.isDirectory() && !details.isSymbolicLink()) await rm(lock, { recursive: true, force: true })
      } else {
        const saved = JSON.parse(await readFile(owner, 'utf8')) as { token?: unknown }
        if (saved.token === token) await rm(lock, { recursive: true, force: true })
      }
    } catch { /* Never remove a lock whose ownership can no longer be proved. */ }
  }
}

/**
 * Remove a lock that provably cannot belong to a running peer.
 *
 * The directory is moved aside before anything is deleted, so a peer that
 * recreated the lock at the same path in the meantime keeps its own directory.
 * If the moved directory turns out to hold a live owner after all, it is put
 * back and the caller keeps waiting; a lock that cannot be proved stale is never
 * destroyed.
 */
async function reclaimStaleLock(lock: string, owner: string): Promise<boolean> {
  let details
  try {
    details = await lstat(lock)
  } catch (error: unknown) {
    if (isMissing(error)) return true
    throw error
  }
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('Ditto mutation lock is a symlink, junction, or non-directory')
  if (!await isStaleLock(owner, details.mtimeMs)) return false
  const aside = `${lock}.stale-${randomUUID()}`
  try {
    await rename(lock, aside)
  } catch (error: unknown) {
    if (isMissing(error)) return true
    // A peer may hold the directory open right now; wait rather than fail the mutation.
    return false
  }
  let moved
  try {
    moved = await lstat(aside)
  } catch {
    return true
  }
  if (await isStaleLock(resolve(aside, 'owner.json'), moved.mtimeMs)) {
    await rm(aside, { recursive: true, force: true }).catch(() => undefined)
    return true
  }
  // It was live after all: restore it and let the caller keep waiting.
  await rename(aside, lock).catch(() => undefined)
  return false
}

/** True when the owner record proves that no live peer holds this lock. */
async function isStaleLock(owner: string, lockModifiedAt: number): Promise<boolean> {
  let saved: { pid?: unknown; host?: unknown }
  try {
    saved = JSON.parse(await readFile(owner, 'utf8')) as { pid?: unknown; host?: unknown }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // The creator died between `mkdir` and the owner write. Give a live one
      // ample time to finish that single write before taking the directory.
      return Date.now() - lockModifiedAt > ORPHAN_GRACE_MS
    }
    // A partially written or unreadable record is never proof of ownership loss.
    return false
  }
  if (saved.host !== hostname() || !Number.isInteger(saved.pid) || (saved.pid as number) < 1) return false
  try {
    process.kill(saved.pid as number, 0)
    return false
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

async function stateLeafPath(stateRoot: string, category: string, leaf: string, createCategory: boolean): Promise<string> {
  if (!LEAF.test(leaf)) throw new Error('Invalid state filename')
  const folder = await stateCategoryPath(stateRoot, category, createCategory)
  const file = resolve(folder, leaf)
  if (!within(folder, file)) throw new Error('Invalid state path')
  if (createCategory) await assertExistingLeafSafe(file, folder)
  else await assertRegularLeaf(file, folder, 'Ditto state file')
  return file
}

async function assertDirectory(path: string, root: string, label: string): Promise<void> {
  const details = await lstat(path)
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(`${label} is a symlink, junction, or non-directory`)
  const actual = await realpath(path)
  if (!samePath(path, actual) || !within(root, actual, true)) throw new Error(`${label} escapes stateRoot through a symlink or junction`)
}

async function assertRegularLeaf(file: string, folder: string, label: string): Promise<void> {
  const details = await lstat(file)
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`${label} is a symlink, junction, or non-file`)
  const actual = await realpath(file)
  if (!samePath(file, actual) || !within(folder, actual)) throw new Error(`${label} escapes its state category`)
}

async function assertExistingLeafSafe(file: string, folder: string): Promise<void> {
  try { await assertRegularLeaf(file, folder, 'Ditto state file') } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}
