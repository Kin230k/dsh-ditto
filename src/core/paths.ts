import { lstat, realpath } from 'node:fs/promises'
import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

/**
 * Path helpers shared by every boundary check.
 *
 * Roots are compared as strings, so both sides must be canonical: the native
 * realpath of the longest existing prefix (which also expands Windows 8.3 short
 * names such as `RUNNER~1`) joined with any not-yet-existing tail. Links are
 * detected per component with `lstat`, never by comparing a realpath with the
 * path it came from — the two legitimately differ on a short-name path.
 */

/** Canonical absolute form of `target`; the tail that does not exist yet is kept verbatim. */
export async function canonicalPath(target: string): Promise<string> {
  const absolute = resolve(target)
  let existing = absolute
  const tail: string[] = []
  for (;;) {
    try {
      const real = await realpath(existing)
      return tail.length ? join(real, ...tail) : real
    } catch (error: unknown) {
      if (!isMissing(error)) throw error
      const parent = dirname(existing)
      if (parent === existing) return absolute
      tail.unshift(basename(existing))
      existing = parent
    }
  }
}

/** Synchronous twin of {@link canonicalPath} for plugin configuration. */
export function canonicalPathSync(target: string): string {
  const absolute = resolve(target)
  let existing = absolute
  const tail: string[] = []
  for (;;) {
    try {
      const real = realpathSync.native(existing)
      return tail.length ? join(real, ...tail) : real
    } catch (error: unknown) {
      if (!isMissing(error)) throw error
      const parent = dirname(existing)
      if (parent === existing) return absolute
      tail.unshift(basename(existing))
      existing = parent
    }
  }
}

/**
 * Rejects a path when any existing component of it is a symbolic link or a
 * Windows junction. Components that do not exist yet are fine: they will be
 * created as ordinary directories.
 */
export async function assertNoLinkAncestor(target: string, message = 'The path has a symlink or junction ancestor'): Promise<void> {
  for (const cursor of ancestorPaths(target)) {
    try {
      const details = await lstat(cursor)
      if (details.isSymbolicLink()) throw new Error(`${message}: ${cursor}`)
    } catch (error: unknown) {
      if (isMissing(error)) return
      throw error
    }
  }
}

/** Synchronous twin of {@link assertNoLinkAncestor}. */
export function assertNoLinkAncestorSync(target: string, message = 'The path has a symlink or junction ancestor'): void {
  for (const cursor of ancestorPaths(target)) {
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error(`${message}: ${cursor}`)
    } catch (error: unknown) {
      if (isMissing(error)) return
      throw error
    }
  }
}

/** Root-aware component iteration preserves drive, UNC, and extended-path roots. */
function ancestorPaths(target: string): string[] {
  const absolute = resolve(target)
  const root = parse(absolute).root
  const segments = absolute.slice(root.length).split(/[\\/]+/).filter(Boolean)
  const result: string[] = []
  let cursor = root
  // Drive, UNC-share, and extended roots are namespaces rather than path
  // components; lstat on an extended drive root is invalid on Windows.
  for (const segment of segments) {
    cursor = join(cursor, segment)
    result.push(cursor)
  }
  return result
}

/** True when `target` lies below `root` (or equals it when `includeRoot`). Cross-drive and parent paths are never inside. */
export function within(root: string, target: string, includeRoot = false): boolean {
  const path = relative(resolve(root), resolve(target))
  return (includeRoot && path === '') || (path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith('../') && !isAbsolute(path))
}

/** Case-insensitive on Windows, exact elsewhere. Both sides must already be canonical. */
export function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? resolve(a).toLocaleLowerCase('en-US') === resolve(b).toLocaleLowerCase('en-US') : resolve(a) === resolve(b)
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}
