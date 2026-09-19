import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import { canonicalPath, samePath, within } from './paths.js'
import { classify, destinationFor, explicitOverrides, isSafeId, ProposalError, safeRelative, stableDigest, validateDestinationExtension, validateRecipe } from './recipe.js'
import { renderArtifacts, ARTIFACT_RENDERER } from './artifacts.js'
import type { ArchiveSpec, ArchiveState, CreatePlanOptions, Plan, PlanDiagnostics, PlanEdit, PlanItem, PlannedArtifact, PlanSummary, ProposalExceptionCode, Recipe, RecipeV2, RuleRevision } from './types.js'

const EXCEPTION_CODES: ProposalExceptionCode[] = ['unmatched', 'unsafe-capture', 'invalid-destination', 'collision']

export async function createPlan(options: CreatePlanOptions): Promise<Plan> {
  if (!options || !Number.isInteger(options.maxFiles ?? 1_000) || (options.maxFiles ?? 1_000) < 1 || (options.maxFiles ?? 1_000) > 10_000) throw new Error('maxFiles must be between 1 and 10,000')
  validateRecipe(options.recipe)
  const sourceRoot = await realpath(options.sourceRoot)
  const destinationRoot = await canonicalPath(options.destinationRoot)
  if (pathsOverlap(sourceRoot, destinationRoot)) throw new Error('Output folder must be separate from and outside the source folder')
  if (options.excludedRoots !== undefined && (!Array.isArray(options.excludedRoots) || options.excludedRoots.length > 20 || options.excludedRoots.some(path => typeof path !== 'string'))) throw new Error('Invalid excluded roots')
  const excludedRoots = await Promise.all((options.excludedRoots ?? []).map(path => canonicalPath(path)))
  // Writes must never land in Ditto's own metadata, and sources must never be read from inside it.
  if (excludedRoots.some(root => pathsOverlap(destinationRoot, root))) throw new Error('The output folder must not overlap Ditto state metadata')
  if (excludedRoots.some(root => within(root, sourceRoot, true))) throw new Error('The source folder must not live inside Ditto state metadata')
  const discoveryExclusions = excludedRoots.filter(root => within(sourceRoot, root, true))
  const files = await collectFiles(sourceRoot, options.maxFiles ?? 1_000, discoveryExclusions)
  const ids = new Set<string>()
  const proposed: PlanItem[] = await Promise.all(files.map(async (source, index) => {
    const relativePath = relative(sourceRoot, source)
    const id = stableDigest(relativePath).slice(0, 16)
    if (ids.has(id)) throw new Error('Source identifiers collided; choose a smaller batch')
    ids.add(id)
    const sourceHash = await sha256(source)
    try {
      const proposal = destinationFor(options.recipe, relativePath, index)
      return {
        id, source, relativePath,
        destination: validateDestinationExtension(proposal.destination, extensionFor(relativePath)),
        sourceHash, classification: proposal.classification,
        proposalDisposition: 'ready', captures: proposal.captures, status: 'ready',
      }
    } catch (error: unknown) {
      if (!(error instanceof ProposalError) || options.recipe.version === 1) throw error
      return {
        id, source, relativePath, destination: '', sourceHash, classification: classify(relativePath),
        proposalDisposition: 'exception', exceptionCode: error.code, exceptionDetails: error.message, status: 'ready',
      }
    }
  }))
  const items = options.recipe.version === 2 ? withCollisionExceptions(proposed) : proposed
  if (options.recipe.version === 1) assertNoCollisions(items)
  const id = randomUUID()
  const artifacts = renderArtifacts({ planId: id, revision: 1, sourceRoot, destinationRoot, items }, options.recipe.sidecars)
  assertNoArtifactCollisions(items, artifacts, options.recipe.archive)
  return withDigest({
    version: 'm0', id, revision: 1, createdAt: new Date().toISOString(),
    sourceRoot, destinationRoot, recipe: options.recipe, items, artifacts,
    ...(options.recipe.archive === undefined ? {} : { archive: options.recipe.archive, archiveState: { status: 'ready' as const } }),
  })
}

export function revisePlan(plan: Plan, edits: PlanEdit[]): Plan {
  assertPlanShape(plan)
  if (!Array.isArray(edits) || edits.length > plan.items.length || edits.some(edit => !edit || typeof edit.id !== 'string' || typeof edit.destination !== 'string')) throw new Error('Invalid plan edits')
  if (plan.items.some(item => item.status !== 'ready' || item.copyIntent !== undefined) || (plan.artifacts ?? []).some(artifact => artifact.status !== 'ready') || (plan.archiveState !== undefined && plan.archiveState.status !== 'ready')) throw new Error('A plan cannot be revised after apply intent or outcomes exist')
  const changes = new Map(edits.map(edit => [edit.id, edit.destination]))
  if (changes.size !== edits.length || [...changes.keys()].some(id => !plan.items.some(item => item.id === id))) throw new Error('Unknown or duplicate plan item')
  if ([...changes.keys()].some(id => plan.items.find(item => item.id === id)?.status !== 'ready')) throw new Error('Only pending items can be revised')

  const revised = plan.items.map(item => {
    if (changes.has(item.id) && item.status === 'ready') {
      const { exceptionCode: _code, exceptionDetails: _details, ...rest } = item
      return {
        ...rest,
        destination: validateDestinationExtension(changes.get(item.id)!, extensionFor(item.relativePath)),
        proposalDisposition: 'ready' as const,
      }
    }
    if (item.proposalDisposition === 'exception' && item.exceptionCode === 'collision') {
      const { exceptionCode: _code, exceptionDetails: _details, ...rest } = item
      return { ...rest, proposalDisposition: 'ready' as const }
    }
    return item
  })
  const items = plan.recipe.version === 2 ? withCollisionExceptions(revised) : revised
  if (plan.recipe.version === 1) assertNoCollisions(items)
  const revision = plan.revision + 1
  const artifacts = renderArtifacts({ planId: plan.id, revision, sourceRoot: plan.sourceRoot, destinationRoot: plan.destinationRoot, items }, plan.recipe.sidecars)
  assertNoArtifactCollisions(items, artifacts, plan.archive)
  return withDigest({ ...plan, revision, items, artifacts, ...(plan.archive === undefined ? {} : { archiveState: { status: 'ready' as const } }) })
}

/** Regenerate every proposal under one revised declarative rule. */
export function revisePlanRule(plan: Plan, revision: RuleRevision): Plan {
  assertPlanShape(plan)
  if (!revision || typeof revision !== 'object' || Array.isArray(revision)) throw new Error('Invalid rule revision')
  if (plan.items.some(item => item.status !== 'ready' || item.copyIntent !== undefined) || (plan.artifacts ?? []).some(artifact => artifact.status !== 'ready') || (plan.archiveState !== undefined && plan.archiveState.status !== 'ready')) throw new Error('A rule cannot be revised after apply intent or outcomes exist')
  if (revision.pattern !== undefined && typeof revision.pattern !== 'string') throw new Error('Invalid rule pattern')
  if (revision.matchRegex !== undefined && revision.matchRegex !== null && typeof revision.matchRegex !== 'string') throw new Error('Invalid match_regex')
  if (revision.matchScope !== undefined && !['basename', 'relative-path'].includes(revision.matchScope)) throw new Error('Invalid match_scope')
  if (revision.matchFlags !== undefined && typeof revision.matchFlags !== 'string') throw new Error('Invalid match_flags')
  if (revision.classification !== undefined && !['folder-prefix', 'none'].includes(revision.classification)) throw new Error('Invalid classification')
  if (revision.preserveOverrides !== undefined && typeof revision.preserveOverrides !== 'boolean') throw new Error('Invalid preserveOverrides')

  const priorMatch = plan.recipe.version === 2 ? plan.recipe.match : undefined
  const pattern = revision.pattern ?? plan.recipe.pattern
  // A v1 pattern treats `{ext}` as dotless. Reusing that text under v2 would
  // silently reinterpret a reviewed rule, so require an explicit rewrite.
  if (plan.recipe.version === 1 && revision.pattern === undefined && pattern.includes('{ext}')) {
    throw new Error('This saved v1 recipe builds names with the dotless {ext} token; pass an explicit pattern (for example "{stem}{ext}" or "{match.code}.pdf") so the new rule is unambiguous')
  }
  let match = priorMatch
  if (revision.matchRegex === null) match = undefined
  else if (revision.matchRegex !== undefined) match = { regex: revision.matchRegex, scope: revision.matchScope ?? priorMatch?.scope ?? 'basename', flags: revision.matchFlags ?? priorMatch?.flags ?? '' }
  else if (revision.matchScope !== undefined || revision.matchFlags !== undefined) {
    if (!priorMatch) throw new Error('match_regex is required before match_scope or match_flags can be revised')
    match = { regex: priorMatch.regex, scope: revision.matchScope ?? priorMatch.scope, flags: revision.matchFlags ?? priorMatch.flags }
  }

  const classification = revision.classification === undefined
    ? plan.recipe.classification
    : { ...plan.recipe.classification, kind: revision.classification }
  const overrides = revision.preserveOverrides ? explicitOverrides(plan) : undefined
  const recipe: RecipeV2 = {
    ...plan.recipe,
    version: 2,
    pattern,
    classification,
    ...(match ? { match } : {}),
    ...(overrides && Object.keys(overrides).length > 0 ? { overrides } : {}),
    ...(revision.sidecars === undefined ? (plan.recipe.sidecars ? { sidecars: plan.recipe.sidecars } : {}) : (revision.sidecars.length > 0 ? { sidecars: revision.sidecars } : {})),
    ...(revision.archive === undefined ? (plan.recipe.archive ? { archive: plan.recipe.archive } : {}) : (revision.archive === null ? {} : { archive: revision.archive })),
  }
  if (!match) delete recipe.match
  if (!overrides || Object.keys(overrides).length === 0) delete recipe.overrides
  validateRecipe(recipe)
  const items = withCollisionExceptions(plan.items.map((item, index) => proposeExistingItem(item, recipe, index)))
  // A rule whose every destination is structurally invalid (for example a
  // template that drops the source extension) is a mistake, not something the
  // user should review item by item. Unmatched or unsafe individual sources
  // stay reviewable exceptions.
  if (items.length > 0 && items.every(item => item.proposalDisposition === 'exception' && item.exceptionCode === 'invalid-destination')) {
    throw new Error(`This rule produced no valid destination for any of the ${items.length} sources: ${items[0]!.exceptionDetails ?? 'unknown reason'}`)
  }
  const nextRevision = plan.revision + 1
  const artifacts = renderArtifacts({ planId: plan.id, revision: nextRevision, sourceRoot: plan.sourceRoot, destinationRoot: plan.destinationRoot, items }, recipe.sidecars)
  const archive = revision.archive === undefined ? plan.archive : (revision.archive ?? undefined)
  assertNoArtifactCollisions(items, artifacts, archive)
  const { archive: _priorArchive, archiveState: _priorArchiveState, ...rest } = plan
  return withDigest({ ...rest, revision: nextRevision, recipe, items, artifacts, ...(archive === undefined ? {} : { archive, archiveState: { status: 'ready' as const } }) })
}

/** Digest only the reviewed identity. Apply status is intentionally mutable for durable resume. */
export function withDigest(plan: Omit<Plan, 'digest' | 'summary' | 'diagnostics'> & Partial<Pick<Plan, 'digest' | 'summary' | 'diagnostics'>>): Plan {
  const digest = stableDigest({
    version: plan.version, id: plan.id, revision: plan.revision, createdAt: plan.createdAt,
    sourceRoot: plan.sourceRoot, destinationRoot: plan.destinationRoot, recipe: plan.recipe,
    items: plan.items.map(item => plan.recipe.version === 1
      ? { id: item.id, source: item.source, relativePath: item.relativePath, destination: item.destination, sourceHash: item.sourceHash, classification: item.classification }
      : {
          id: item.id, source: item.source, relativePath: item.relativePath, destination: item.destination,
          sourceHash: item.sourceHash, classification: item.classification,
          proposalDisposition: item.proposalDisposition, exceptionCode: item.exceptionCode,
          exceptionDetails: item.exceptionDetails, captures: item.captures,
        }),
    // Sidecar bytes and the archive path are reviewed content: their hashes are
    // part of the identity, while only their apply status stays mutable.
    // Old 0.1 plans did not have an `artifacts` field. Omitting it preserves
    // their frozen digest; newly created 0.2 plans always store an array.
    ...(plan.artifacts === undefined ? {} : { artifacts: plan.artifacts.map(artifact => ({
      id: artifact.id, kind: artifact.kind, destination: artifact.destination,
      renderer: artifact.renderer, contentHash: artifact.contentHash, bytes: artifact.bytes,
    })) }),
    ...(plan.archive === undefined ? {} : { archive: plan.archive }),
  })
  return { ...plan, digest, summary: summarize(plan.items), diagnostics: diagnose(plan.items, plan.artifacts) } as Plan
}

export function summarize(items: PlanItem[]): PlanSummary {
  return {
    total: items.length,
    ready: items.filter(item => item.proposalDisposition !== 'exception' && item.status === 'ready').length,
    exception: items.filter(item => item.proposalDisposition === 'exception').length,
    applying: items.filter(item => item.status === 'applying').length,
    applied: items.filter(item => item.status === 'applied').length,
    rejected: items.filter(item => item.status === 'rejected').length,
    failed: items.filter(item => item.status === 'failed').length,
  }
}

export function diagnose(items: PlanItem[], artifacts: readonly PlannedArtifact[] = []): PlanDiagnostics {
  const counts = new Map<ProposalExceptionCode, number>(EXCEPTION_CODES.map(code => [code, 0]))
  for (const item of items) if (item.proposalDisposition === 'exception' && item.exceptionCode) counts.set(item.exceptionCode, (counts.get(item.exceptionCode) ?? 0) + 1)
  const exceptionsByReason = Object.fromEntries(EXCEPTION_CODES.flatMap(code => {
    const count = counts.get(code) ?? 0
    return count === 0 ? [] : [[code, count]]
  }))
  return {
    ready: items.filter(item => item.proposalDisposition !== 'exception' && item.status === 'ready').length,
    exceptions: items.filter(item => item.proposalDisposition === 'exception').length,
    exceptionsByReason,
    collisions: counts.get('collision') ?? 0,
    unmatched: counts.get('unmatched') ?? 0,
    artifactCount: artifacts.length,
  }
}

/** Throws if two copyable items target the same or overlapping output path. */
export function assertNoCollisions(items: PlanItem[]): void {
  const collision = firstCollision(items)
  if (!collision) return
  if (collision.kind === 'same') throw new Error(`Two files would use the same destination: ${collision.destination}`)
  throw new Error(`A file destination would be an ancestor of another destination: ${collision.destination}`)
}

/**
 * Sidecars, the archive, and file destinations share one output tree, so they
 * must be mutually disjoint: a sidecar may not sit inside a directory that a
 * reviewed file also occupies, and the archive may not be one of its own inputs.
 */
export function assertNoArtifactCollisions(items: readonly PlanItem[], artifacts: readonly PlannedArtifact[], archive?: ArchiveSpec): void {
  const entries: Array<{ label: string; destination: string }> = []
  for (const item of items) if (item.destination !== '' && item.proposalDisposition !== 'exception') entries.push({ label: 'a reviewed file', destination: item.destination })
  for (const artifact of artifacts) entries.push({ label: 'a sidecar', destination: artifact.destination })
  if (archive) entries.push({ label: 'the archive', destination: archive.destination })
  const seen = new Map<string, string>()
  for (const entry of entries) {
    const key = collisionKey(entry.destination)
    const prior = seen.get(key)
    if (prior !== undefined) throw new Error(`${entry.label} would use the same path as ${prior}: ${entry.destination}`)
    seen.set(key, entry.label)
  }
  for (const [key, label] of seen) {
    const segments = key.split('/')
    for (let length = 1; length < segments.length; length++) {
      const ancestor = seen.get(segments.slice(0, length).join('/'))
      if (ancestor !== undefined) throw new Error(`${label} and ${ancestor} overlap in the output tree: ${key}`)
    }
  }
}

export async function sha256(file: string): Promise<string> {
  return await new Promise((resolveHash, reject) => {
    const hash = createHash('sha256'); const input = createReadStream(file)
    input.on('error', reject); input.on('data', chunk => hash.update(chunk)); input.on('end', () => resolveHash(hash.digest('hex')))
  })
}

export { within, samePath } from './paths.js'

function extensionFor(relativePath: string): string { return extname(relativePath) }
function pathsOverlap(a: string, b: string): boolean { return within(a, b, true) || within(b, a, true) }

function proposeExistingItem(item: PlanItem, recipe: Recipe, index: number): PlanItem {
  const base = { id: item.id, source: item.source, relativePath: item.relativePath, sourceHash: item.sourceHash, status: 'ready' as const }
  try {
    const proposal = destinationFor(recipe, item.relativePath, index)
    return {
      ...base,
      destination: validateDestinationExtension(proposal.destination, extensionFor(item.relativePath)),
      classification: proposal.classification,
      proposalDisposition: 'ready',
      captures: proposal.captures,
    }
  } catch (error: unknown) {
    if (!(error instanceof ProposalError)) throw error
    return {
      ...base,
      destination: '',
      classification: classify(item.relativePath),
      proposalDisposition: 'exception',
      exceptionCode: error.code,
      exceptionDetails: error.message,
    }
  }
}

function withCollisionExceptions(items: PlanItem[]): PlanItem[] {
  const conflicts = collisionIndexes(items)
  return items.map((item, index) => conflicts.has(index) && item.status === 'ready'
    ? { ...item, proposalDisposition: 'exception', exceptionCode: 'collision', exceptionDetails: 'Destination collides with another proposed file path.' }
    : item)
}

function collisionIndexes(items: PlanItem[]): Set<number> {
  const groups = new Map<string, number[]>()
  for (const [index, item] of items.entries()) {
    if (item.proposalDisposition === 'exception' || item.destination === '') continue
    const key = collisionKey(item.destination)
    const group = groups.get(key)
    if (group) group.push(index)
    else groups.set(key, [index])
  }
  const conflicts = new Set<number>()
  for (const group of groups.values()) if (group.length > 1) for (const index of group) conflicts.add(index)
  for (const [key, descendants] of groups) {
    const segments = key.split('/')
    for (let length = 1; length < segments.length; length++) {
      const ancestors = groups.get(segments.slice(0, length).join('/'))
      if (!ancestors) continue
      for (const index of ancestors) conflicts.add(index)
      for (const index of descendants) conflicts.add(index)
    }
  }
  return conflicts
}

function firstCollision(items: PlanItem[]): { kind: 'same' | 'ancestor'; destination: string } | undefined {
  const groups = new Map<string, string>()
  for (const item of items) {
    if (item.proposalDisposition === 'exception' || item.destination === '') continue
    const key = collisionKey(item.destination)
    if (groups.has(key)) return { kind: 'same', destination: item.destination }
    groups.set(key, item.destination)
  }
  for (const [key, destination] of groups) {
    const segments = key.split('/')
    for (let length = 1; length < segments.length; length++) if (groups.has(segments.slice(0, length).join('/'))) return { kind: 'ancestor', destination }
  }
  return undefined
}

function collisionKey(destination: string): string {
  return safeRelative(destination).replace(/[\\/]/g, '/').toLocaleLowerCase('en-US')
}

async function collectFiles(root: string, maxFiles: number, excludedRoots: string[]): Promise<string[]> {
  const result: string[] = []
  async function walk(folder: string): Promise<void> {
    const listed = await readdir(folder, { withFileTypes: true })
    for (const entry of listed) {
      const candidate = join(folder, entry.name)
      const details = await lstat(candidate)
      const actual = await realpath(candidate)
      if (details.isSymbolicLink() || !within(root, actual)) throw new Error(`Symlinks and junctions are not allowed in a batch: ${candidate}`)
      if (details.isDirectory() && (['.git', 'node_modules', '.dsh-ditto'].includes(entry.name) || excludedRoots.some(excluded => samePath(excluded, actual) || within(excluded, actual, true)))) continue
      if (details.isDirectory()) await walk(candidate)
      else if (details.isFile()) { result.push(actual); if (result.length > maxFiles) throw new Error(`Batch exceeds ${maxFiles} files`) }
    }
  }
  await walk(root)
  // Fixed code-unit ordering keeps {index} proposals and digests identical
  // across machines with different ICU locales.
  return result.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

export function assertPlanShape(plan: Plan): void {
  if (!plan || plan.version !== 'm0' || !isSafeId(plan.id) || !Number.isInteger(plan.revision) || plan.revision < 1 || typeof plan.digest !== 'string' || !Array.isArray(plan.items) || plan.items.length > 10_000 || !plan.items.every(item => validPlanItem(item, plan.recipe?.version))) throw new Error('Invalid plan')
  validateRecipe(plan.recipe)
  assertNoCollisions(plan.items)
  if (plan.artifacts !== undefined && (!Array.isArray(plan.artifacts) || plan.artifacts.length > 8 || !plan.artifacts.every(validArtifact))) throw new Error('Invalid plan sidecars')
  if (plan.archive === undefined && plan.archiveState !== undefined) throw new Error('Invalid plan archive state')
  if (plan.archiveState !== undefined && !validArchiveState(plan.archiveState)) throw new Error('Invalid plan archive state')
  assertNoArtifactCollisions(plan.items, plan.artifacts ?? [], plan.archive)
}

function validArchiveState(state: ArchiveState): boolean {
  if (!state || !['ready', 'applying', 'applied', 'failed'].includes(state.status)) return false
  if (state.contentHash !== undefined && !/^[a-f0-9]{64}$/i.test(state.contentHash)) return false
  if (state.bytes !== undefined && (!Number.isInteger(state.bytes) || state.bytes < 0)) return false
  if ((state.status === 'applying' || state.status === 'applied') && (state.contentHash === undefined || state.bytes === undefined)) return false
  return state.reason === undefined || typeof state.reason === 'string'
}

function validArtifact(artifact: PlannedArtifact): boolean {
  if (!artifact || typeof artifact.id !== 'string' || !['manifest', 'checksums', 'sql-insert'].includes(artifact.kind)) return false
  if (typeof artifact.destination !== 'string' || typeof artifact.renderer !== 'string' || artifact.renderer !== ARTIFACT_RENDERER) return false
  if (!/^[a-f0-9]{64}$/i.test(artifact.contentHash) || !Number.isInteger(artifact.bytes) || artifact.bytes < 0) return false
  if (!['ready', 'applying', 'applied', 'failed', 'rejected'].includes(artifact.status)) return false
  try { safeRelative(artifact.destination) } catch { return false }
  return artifact.reason === undefined || typeof artifact.reason === 'string'
}

function validPlanItem(item: PlanItem, recipeVersion: unknown): boolean {
  if (!item || typeof item.id !== 'string' || typeof item.source !== 'string' || typeof item.relativePath !== 'string' || typeof item.destination !== 'string' || !/^[a-f0-9]{64}$/i.test(item.sourceHash) || !['ready', 'applying', 'applied', 'rejected', 'failed'].includes(item.status)) return false
  if (item.proposalDisposition === undefined && recipeVersion === 1) return true
  if (!['ready', 'exception'].includes(item.proposalDisposition)) return false
  if (item.proposalDisposition === 'exception' && (item.status !== 'ready' || !item.exceptionCode || !EXCEPTION_CODES.includes(item.exceptionCode))) return false
  if (item.proposalDisposition === 'ready' && item.exceptionCode !== undefined) return false
  if (item.exceptionDetails !== undefined && typeof item.exceptionDetails !== 'string') return false
  return item.captures === undefined || (item.captures !== null && typeof item.captures === 'object' && Object.values(item.captures).every(value => typeof value === 'string'))
}
