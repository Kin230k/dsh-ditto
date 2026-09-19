import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { assertNoCollisions, assertNoArtifactCollisions, assertPlanShape, samePath, sha256, within, withDigest } from './plan.js'
import { reviewArtifact } from './artifacts.js'
import { assertNoLinkAncestor } from './paths.js'
import { safeRelative } from './recipe.js'
import { inspectZipFile, writeZipFile, type ZipFileEntry } from './zip.js'
import { loadPlan, savePlan } from './storage.js'
import { withStateLock } from './state-paths.js'
import type { ApplyResult, ArchiveState, Deliverables, Plan, PlanItem, PlannedArtifact } from './types.js'

export interface ApplyExpectation { id: string; revision: number; digest: string }
const planLocks = new Map<string, Promise<void>>()

/**
 * Applies only the exact reviewed identity, in three ordered stages: reviewed
 * copies, then reviewed sidecars, then the optional archive. A stage only
 * starts once every earlier stage is durably complete, so a failure or a crash
 * can never produce an archive that describes outputs which were not written.
 */
export async function applyPlan(submitted: Plan, expected: ApplyExpectation, stateRoot: string): Promise<ApplyResult> {
  return await withPlanLock(stateRoot, expected.id, async () => {
    assertPlanShape(submitted)
    if (submitted.id !== expected.id || submitted.revision !== expected.revision || submitted.digest !== expected.digest) throw new Error('Apply must name the exact reviewed plan')
    const persisted = await loadPlan(expected.id, stateRoot)
    if (persisted.revision !== expected.revision || persisted.digest !== expected.digest) throw new Error('Plan changed after review; refresh the preview')
    assertNoCollisions(persisted.items)
    assertNoArtifactCollisions(persisted.items, persisted.artifacts ?? [], persisted.archive)
    const sourceRoot = await realpath(persisted.sourceRoot)
    if (!samePath(sourceRoot, persisted.sourceRoot)) throw new Error('Source root changed after preview')
    const destinationRoot = await prepareDestinationRoot(persisted.destinationRoot)
    let current = persisted
    for (const item of current.items) {
      // Reviewed exceptions are deliberately skipped: they were shown to the user
      // as "no destination", so they never block the copyable items.
      if (item.proposalDisposition === 'exception') continue
      if (item.status === 'applied') { await assertCompletedItem(item, destinationRoot); continue }
      if (item.status !== 'ready' && item.status !== 'applying') continue
      // Only an intent persisted by an earlier, interrupted run may adopt an
      // exact pre-existing output. A file that merely happens to match is never
      // touched, so the non-overwrite guarantee still holds.
      const resumedIntent = item.status === 'applying' && item.copyIntent !== undefined
      if (!resumedIntent) {
        const applying = { ...item, status: 'applying' as const, copyIntent: { destination: item.destination, sourceHash: item.sourceHash, startedAt: new Date().toISOString() } }
        current = withDigest({ ...current, digest: '', items: current.items.map(candidate => candidate.id === item.id ? applying : candidate) })
        await savePlan(current, stateRoot)
      }
      const pending = current.items.find(candidate => candidate.id === item.id)!
      const outcome = await applyItem(pending, sourceRoot, destinationRoot, resumedIntent)
      const items = current.items.map(candidate => candidate.id === item.id ? outcome : candidate)
      current = withDigest({ ...current, digest: '', items })
      await savePlan(current, stateRoot)
    }

    // Stage 2: sidecars only after every copy has a durable outcome. Reviewed
    // exceptions never block: they were shown to the user as "no destination",
    // and a legacy plan predates the field entirely, so it is never an exception.
    const blockedCopies = current.items.filter(item => item.proposalDisposition !== 'exception' && item.status !== 'applied')
    const artifacts = current.artifacts ?? []
    if (blockedCopies.length === 0) {
      for (const artifact of artifacts) {
        if (artifact.status === 'applied') { await assertCompletedArtifact(artifact, destinationRoot); continue }
        if (artifact.status !== 'ready' && artifact.status !== 'applying') continue
        const resumed = artifact.status === 'applying'
        if (!resumed) {
          const applying = { ...artifact, status: 'applying' as const }
          current = withDigest({ ...current, digest: '', artifacts: (current.artifacts ?? []).map(candidate => candidate.id === artifact.id ? applying : candidate) })
          await savePlan(current, stateRoot)
        }
        const pending = (current.artifacts ?? []).find(candidate => candidate.id === artifact.id)!
        const outcome = await writeArtifact(pending, current, destinationRoot, resumed)
        current = withDigest({ ...current, digest: '', artifacts: (current.artifacts ?? []).map(candidate => candidate.id === artifact.id ? outcome : candidate) })
        await savePlan(current, stateRoot)
      }
    }

    // Stage 3: the archive is built from the persisted allowlist, never by
    // walking the output folder, so unreviewed files can never enter it.
    const blockedSidecars = (current.artifacts ?? []).filter(artifact => artifact.status !== 'applied')
    const archive = current.archive
    if (archive && blockedCopies.length === 0 && blockedSidecars.length === 0) {
      const prior = current.archiveState ?? { status: 'ready' as const }
      if (prior.status === 'applied') {
        await assertCompletedArchive(archive.destination, prior, destinationRoot)
      } else if (prior.status === 'ready' || prior.status === 'applying') {
        const prepared = await prepareReviewedArchive(archive.destination, current, destinationRoot)
        try {
          const expected = prior.status === 'applying'
            ? prior
            : { status: 'applying' as const, contentHash: prepared.contentHash, bytes: prepared.bytes }
          if (prior.status === 'applying' && (prior.contentHash !== prepared.contentHash || prior.bytes !== prepared.bytes)) throw new Error('The archive inputs changed after its durable write intent; no archive was adopted')
          if (prior.status === 'ready') {
            if (await exists(prepared.target)) {
              current = withDigest({ ...current, digest: '', archiveState: { status: 'failed', reason: 'The archive destination already exists; no file was written or adopted without an earlier durable intent.' } })
              await savePlan(current, stateRoot)
            } else {
              current = withDigest({ ...current, digest: '', archiveState: expected })
              await savePlan(current, stateRoot)
              const outcome = await writeArchive(prepared, expected, false)
              current = withDigest({ ...current, digest: '', archiveState: outcome })
              await savePlan(current, stateRoot)
            }
          } else {
            const outcome = await writeArchive(prepared, expected, true)
            current = withDigest({ ...current, digest: '', archiveState: outcome })
            await savePlan(current, stateRoot)
          }
        } finally { await rm(prepared.temporary, { force: true }).catch(() => undefined) }
      }
    }

    return {
      planId: current.id, revision: current.revision, digest: current.digest,
      items: current.items, artifacts: current.artifacts ?? [], summary: current.summary,
      deliverables: await collectDeliverables(current, destinationRoot),
    }
  })
}

/** Every path this apply produced, so the agent can present the archive instead of hundreds of files. */
async function collectDeliverables(plan: Plan, destinationRoot: string): Promise<Deliverables> {
  // `proposalDisposition` is absent on plans persisted before 0.2, where every
  // item was copyable; only an explicit exception is ever left out.
  const files = plan.items.filter(item => item.status === 'applied' && item.proposalDisposition !== 'exception').map(item => item.destination)
  const sidecars = (plan.artifacts ?? []).filter(artifact => artifact.status === 'applied').map(artifact => artifact.destination)
  const archive = plan.archive && plan.archiveState?.status === 'applied' ? plan.archive.destination : undefined
  return { outputRoot: destinationRoot, files, sidecars, ...(archive === undefined ? {} : { archive }) }
}

async function writeArtifact(artifact: PlannedArtifact, plan: Plan, destinationRoot: string, adoptExisting: boolean): Promise<PlannedArtifact> {
  try {
    const content = reviewArtifact(artifact, { planId: plan.id, revision: plan.revision, sourceRoot: plan.sourceRoot, destinationRoot: plan.destinationRoot, items: plan.items }, plan.recipe.sidecars)
    const destination = await safeOutput(artifact.destination, destinationRoot)
    if (await exists(destination)) {
      if (adoptExisting && (await sha256(destination)) === artifact.contentHash) return { ...artifact, status: 'applied', reason: undefined }
      return { ...artifact, status: 'failed', reason: 'The sidecar destination already exists; no file was written to avoid overwriting it.' }
    }
    const temporary = join(dirname(destination), `.dsh-ditto-${artifact.id}-${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' })
      if (await sha256(temporary) !== artifact.contentHash) return { ...artifact, status: 'failed', reason: 'The sidecar did not render to the reviewed bytes; nothing was written.' }
      await copyFile(temporary, destination, constants.COPYFILE_EXCL)
      if ((await sha256(destination)) !== artifact.contentHash) return { ...artifact, status: 'failed', reason: 'Sidecar verification failed after writing; inspect the file before continuing.' }
      return { ...artifact, status: 'applied', reason: undefined }
    } finally { await rm(temporary, { force: true }).catch(() => undefined) }
  } catch (error: unknown) {
    return { ...artifact, status: 'failed', reason: (error instanceof Error ? error.message : 'Unknown sidecar failure').slice(0, 300) }
  }
}

interface PreparedArchive { target: string; temporary: string; contentHash: string; bytes: number }

async function prepareReviewedArchive(destination: string, plan: Plan, destinationRoot: string): Promise<PreparedArchive> {
  const target = await safeOutput(destination, destinationRoot)
  const entries: ZipFileEntry[] = []
  // Exactly the reviewed, successful outputs: verified regular files with the reviewed hash.
  const planned = [
    ...plan.items.filter(item => item.status === 'applied' && item.proposalDisposition !== 'exception').map(item => ({ name: item.destination.replace(/\\/g, '/'), hash: item.sourceHash })),
    ...(plan.artifacts ?? []).filter(artifact => artifact.status === 'applied').map(artifact => ({ name: artifact.destination.replace(/\\/g, '/'), hash: artifact.contentHash })),
  ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of planned) {
    const file = resolve(destinationRoot, safeRelative(entry.name))
    if (!within(destinationRoot, file)) throw new Error(`An archive entry escaped the output folder: ${entry.name}`)
    const details = await lstat(file)
    if (!details.isFile() || details.isSymbolicLink()) throw new Error(`An archive entry is not a regular file: ${entry.name}`)
    const inspected = await inspectZipFile(file)
    if (inspected.contentHash !== entry.hash) throw new Error(`An output changed after it was applied; no archive was created: ${entry.name}`)
    entries.push({ name: entry.name, path: file, ...inspected })
  }
  const temporary = join(dirname(target), `.dsh-ditto-archive-${randomUUID()}.tmp`)
  try {
    await writeZipFile(entries, temporary)
    const details = await lstat(temporary)
    if (!details.isFile() || details.isSymbolicLink()) throw new Error('The temporary archive is not a regular file')
    return { target, temporary, contentHash: await sha256(temporary), bytes: details.size }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

async function writeArchive(prepared: PreparedArchive, expected: ArchiveState, adoptExisting: boolean): Promise<ArchiveState> {
  try {
    if (await exists(prepared.target)) {
      const details = await lstat(prepared.target)
      if (adoptExisting && details.isFile() && !details.isSymbolicLink() && await sha256(prepared.target) === expected.contentHash) return { ...expected, status: 'applied', reason: undefined }
      return { ...expected, status: 'failed', reason: 'The archive destination already exists and does not match a durable intent from an interrupted run.' }
    }
    await copyFile(prepared.temporary, prepared.target, constants.COPYFILE_EXCL)
    const details = await lstat(prepared.target)
    if (!details.isFile() || details.isSymbolicLink() || details.size !== expected.bytes || await sha256(prepared.target) !== expected.contentHash) return { ...expected, status: 'failed', reason: 'Archive verification failed after writing; inspect the destination before continuing.' }
    return { ...expected, status: 'applied', reason: undefined }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST' && adoptExisting) {
      try {
        const details = await lstat(prepared.target)
        if (details.isFile() && !details.isSymbolicLink() && await sha256(prepared.target) === expected.contentHash) return { ...expected, status: 'applied', reason: undefined }
      } catch { /* fall through to a failed outcome */ }
    }
    return { ...expected, status: 'failed', reason: (error instanceof Error ? error.message : 'Unknown archive failure').slice(0, 300) }
  }
}

async function assertCompletedArchive(destination: string, state: ArchiveState, destinationRoot: string): Promise<void> {
  const target = await safeOutput(destination, destinationRoot)
  const details = await lstat(target)
  if (!details.isFile() || details.isSymbolicLink() || details.size !== state.bytes || await sha256(target) !== state.contentHash) throw new Error(`Previously applied archive is missing or changed: ${destination}`)
}

async function assertCompletedArtifact(artifact: PlannedArtifact, destinationRoot: string): Promise<void> {
  const target = await safeOutput(artifact.destination, destinationRoot)
  const details = await lstat(target)
  if (!details.isFile() || details.isSymbolicLink() || await sha256(target) !== artifact.contentHash) throw new Error(`Previously applied sidecar is missing or changed: ${artifact.destination}`)
}

async function applyItem(item: PlanItem, sourceRoot: string, destinationRoot: string, adoptExisting = false): Promise<PlanItem> {
  try {
    const source = await safeExistingSource(item.source, sourceRoot)
    if (await sha256(source) !== item.sourceHash) return { ...item, status: 'rejected', copyIntent: undefined, reason: 'The source file changed after the preview; no copy was created.' }
    const destination = await safeOutput(item.destination, destinationRoot)
    if (await exists(destination)) {
      // A crash between the verified copy and the status write leaves an exact
      // reviewed output behind. Adopt it only when an earlier run recorded the
      // intent; an unrelated pre-existing file is never touched.
      if (adoptExisting && await matchesIntent(item, destination)) return { ...item, status: 'applied', copyIntent: undefined }
      return { ...item, status: 'failed', copyIntent: undefined, reason: 'The destination already exists; no copy was created to avoid overwriting it. If it is a copy from an interrupted run, inspect it first.' }
    }
    const temporary = join(dirname(destination), `.dsh-ditto-${item.id}-${randomUUID()}.tmp`)
    try {
      await copyFile(source, temporary, constants.COPYFILE_EXCL)
      const sourceAfter = await sha256(source)
      const temporaryHash = await sha256(temporary)
      if (sourceAfter !== item.sourceHash || temporaryHash !== item.sourceHash) return { ...item, status: 'rejected', copyIntent: undefined, reason: 'The source changed during copying or the output failed verification; no copy was created.' }
      await copyFile(temporary, destination, constants.COPYFILE_EXCL)
      if (await sha256(destination) !== item.sourceHash) return { ...item, status: 'failed', copyIntent: undefined, reason: 'Output verification failed; inspect the destination before continuing.' }
      return { ...item, status: 'applied', copyIntent: undefined }
    } finally { await rm(temporary, { force: true }).catch(() => undefined) }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown copy failure'
    return { ...item, status: 'failed', copyIntent: undefined, reason: message.slice(0, 300) }
  }
}

/** True only for the exact regular, non-linked output this plan recorded an intent to create. */
async function matchesIntent(item: PlanItem, destination: string): Promise<boolean> {
  const intent = item.copyIntent
  if (!intent || intent.destination !== item.destination || intent.sourceHash !== item.sourceHash) return false
  try {
    const details = await lstat(destination)
    if (!details.isFile() || details.isSymbolicLink()) return false
    return await sha256(destination) === item.sourceHash
  } catch { return false }
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
  await assertNoLinkAncestor(expected, 'Output root has a symlink or junction ancestor')
  await mkdir(expected, { recursive: true })
  const details = await lstat(expected)
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('Output root is a symlink, junction, or non-directory')
  return await realpath(expected)
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

async function withPlanLock<T>(stateRoot: string, id: string, work: () => Promise<T>): Promise<T> {
  const previous = planLocks.get(id) ?? Promise.resolve()
  let release!: () => void
  const queued = new Promise<void>(resolveRelease => { release = resolveRelease })
  const tail = previous.then(() => queued)
  planLocks.set(id, tail)
  await previous
  try { return await withStateLock(stateRoot, id, work) } finally { release(); if (planLocks.get(id) === tail) planLocks.delete(id) }
}
