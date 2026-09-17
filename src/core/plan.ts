import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import { canonicalPath, samePath, within } from './paths.js'
import { destinationFor, isSafeId, safeRelative, stableDigest, validateDestinationExtension, validateRecipe } from './recipe.js'
import type { CreatePlanOptions, Plan, PlanEdit, PlanItem, PlanSummary } from './types.js'

export async function createPlan(options: CreatePlanOptions): Promise<Plan> {
  if (!options || !Number.isInteger(options.maxFiles ?? 1_000) || (options.maxFiles ?? 1_000) < 1 || (options.maxFiles ?? 1_000) > 10_000) throw new Error('maxFiles must be between 1 and 10,000')
  validateRecipe(options.recipe)
  const sourceRoot = await realpath(options.sourceRoot)
  const destinationRoot = await canonicalPath(options.destinationRoot)
  if (within(sourceRoot, destinationRoot, true) || samePath(sourceRoot, destinationRoot)) throw new Error('Output folder must be outside the source folder')
  if (options.excludedRoots !== undefined && (!Array.isArray(options.excludedRoots) || options.excludedRoots.length > 20 || options.excludedRoots.some(path => typeof path !== 'string'))) throw new Error('Invalid excluded roots')
  const excludedRoots = (await Promise.all((options.excludedRoots ?? []).map(path => canonicalPath(path)))).filter(path => within(sourceRoot, path, true))
  const files = await collectFiles(sourceRoot, options.maxFiles ?? 1_000, excludedRoots)
  const ids = new Set<string>()
  const items: PlanItem[] = await Promise.all(files.map(async (source, index) => {
    const relativePath = relative(sourceRoot, source)
    const proposal = destinationFor(options.recipe, relativePath, index)
    const id = stableDigest(relativePath).slice(0, 16)
    if (ids.has(id)) throw new Error('Source identifiers collided; choose a smaller batch')
    ids.add(id)
    return { id, source, relativePath, destination: validateDestinationExtension(proposal.destination, extensionFor(relativePath)), sourceHash: await sha256(source), classification: proposal.classification, status: 'ready' }
  }))
  assertNoCollisions(items)
  const plan = { version: 'm0' as const, id: randomUUID(), revision: 1, digest: '', createdAt: new Date().toISOString(), sourceRoot, destinationRoot, recipe: options.recipe, items, summary: summarize(items) }
  return withDigest(plan)
}

export function revisePlan(plan: Plan, edits: PlanEdit[]): Plan {
  assertPlanShape(plan)
  if (!Array.isArray(edits) || edits.length > plan.items.length) throw new Error('Invalid plan edits')
  const changes = new Map(edits.map(edit => [edit.id, edit.destination]))
  if (changes.size !== edits.length || [...changes.keys()].some(id => !plan.items.some(item => item.id === id))) throw new Error('Unknown or duplicate plan item')
  if ([...changes.keys()].some(id => plan.items.find(item => item.id === id)?.status !== 'ready')) throw new Error('Only pending items can be revised')
  const items = plan.items.map(item => changes.has(item.id) && item.status === 'ready'
    ? { ...item, destination: validateDestinationExtension(changes.get(item.id)!, extensionFor(item.relativePath)) }
    : item)
  assertNoCollisions(items)
  return withDigest({ ...plan, revision: plan.revision + 1, digest: '', items, summary: summarize(items) })
}

/** Digest only the reviewed identity. Apply status is intentionally mutable for durable resume. */
export function withDigest(plan: Omit<Plan, 'digest'> & { digest?: string }): Plan {
  const digest = stableDigest({
    version: plan.version, id: plan.id, revision: plan.revision, createdAt: plan.createdAt,
    sourceRoot: plan.sourceRoot, destinationRoot: plan.destinationRoot, recipe: plan.recipe,
    items: plan.items.map(item => ({ id: item.id, source: item.source, relativePath: item.relativePath, destination: item.destination, sourceHash: item.sourceHash, classification: item.classification })),
  })
  return { ...plan, digest } as Plan
}

export function summarize(items: PlanItem[]): PlanSummary {
  return { total: items.length, ready: items.filter(i => i.status === 'ready').length, applied: items.filter(i => i.status === 'applied').length, rejected: items.filter(i => i.status === 'rejected').length, failed: items.filter(i => i.status === 'failed').length }
}

export function assertNoCollisions(items: PlanItem[]): void {
  const seen = new Set<string>()
  for (const item of items) {
    const destination = safeRelative(item.destination)
    const key = destination.replace(/[\\/]/g, '/').toLocaleLowerCase('en-US')
    if (seen.has(key)) throw new Error(`Two files would use the same destination: ${item.destination}`)
    seen.add(key)
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
  return result.sort((a, b) => a.localeCompare(b))
}

export function assertPlanShape(plan: Plan): void {
  if (!plan || plan.version !== 'm0' || !isSafeId(plan.id) || !Number.isInteger(plan.revision) || plan.revision < 1 || typeof plan.digest !== 'string' || !Array.isArray(plan.items) || plan.items.length > 10_000 || !plan.items.every(item => item && typeof item.id === 'string' && typeof item.source === 'string' && typeof item.relativePath === 'string' && typeof item.destination === 'string' && /^[a-f0-9]{64}$/i.test(item.sourceHash) && ['ready', 'applied', 'rejected', 'failed'].includes(item.status))) throw new Error('Invalid plan')
  validateRecipe(plan.recipe)
  assertNoCollisions(plan.items)
}
