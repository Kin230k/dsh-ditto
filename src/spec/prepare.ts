import { createHash, randomUUID } from 'node:crypto'
import { readFile, lstat, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { safeRelative, stableDigest } from '../core/recipe.js'
import { samePath, within } from '../core/plan.js'
import type { CreateSpecBatchOptions, EvidenceChunk, SpecBatch, SpecBatchSummary, SpecDiscovery, SpecExclusion, SpecModule } from './types.js'

const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
const IGNORED_FOLDERS = new Set(['.git', 'node_modules', '.dsh-ditto', 'dist', 'build', 'generated', 'coverage', 'test', 'tests'])
const MAX_SOURCE_BYTES = 1_000_000
const EVIDENCE_LINES = 24

/** Reads source text only. It never imports, evaluates, or executes a discovered module. */
export async function createSpecBatch(options: CreateSpecBatchOptions): Promise<SpecBatch> {
  if (!options || typeof options.sourceRoot !== 'string' || typeof options.outputRoot !== 'string') throw new Error('來源與輸出資料夾必填')
  const minModules = options.minModules ?? 10; const maxModules = options.maxModules ?? 50
  if (!Number.isInteger(minModules) || !Number.isInteger(maxModules) || minModules < 10 || minModules > maxModules || maxModules > 50) throw new Error('批次模組數必須介於 10 到 50')
  const sourceRoot = await realpath(options.sourceRoot); const outputRoot = resolve(options.outputRoot)
  if (samePath(sourceRoot, outputRoot) || within(sourceRoot, outputRoot, true)) throw new Error('規格輸出資料夾必須位於來源資料夾外')
  const stateRoot = options.stateRoot && within(sourceRoot, resolve(options.stateRoot), true) ? resolve(options.stateRoot) : undefined
  const scan = await collectSourceFiles(sourceRoot, maxModules, stateRoot)
  const files = scan.files
  if (files.length < minModules) throw new Error(`需要至少 ${minModules} 個 TypeScript/JavaScript 模組；目前只有 ${files.length} 個`)
  const items = await Promise.all(files.map((source, index) => prepareModule(sourceRoot, source, index)))
  assertOutputCollisions(items)
  const samples = chooseSamples(items)
  const batch: SpecBatch = {
    version: 'm1', id: randomUUID(), revision: 1, digest: '', createdAt: new Date().toISOString(), sourceRoot, outputRoot,
    recipe: { version: 1, instructions: normalizeInstructions(options.instructions ?? ''), approvedSamples: [] }, discovery: scan.discovery, samples, items,
    summary: summarizeSpecItems(items),
  }
  return withSpecDigest(batch)
}

export async function prepareModule(sourceRoot: string, source: string, index: number): Promise<SpecModule> {
  const actual = await realpath(source); const info = await lstat(actual)
  if (!info.isFile() || info.isSymbolicLink() || !within(sourceRoot, actual)) throw new Error(`不接受連結或資料夾外的來源：${source}`)
  if (info.size > MAX_SOURCE_BYTES) throw new Error(`來源檔案過大：${source}`)
  const bytes = await readFile(actual); const text = bytes.toString('utf8')
  if (text.includes('\u0000')) throw new Error(`來源不是可處理的文字檔：${source}`)
  const relativePath = relative(sourceRoot, actual).split(sep).join('/')
  safeRelative(relativePath)
  const sourceHash = hash(bytes); const evidence = makeEvidence(relativePath, text)
  const id = `module_${stableDigest(relativePath).slice(0, 20)}`
  return { id, source: actual, relativePath, sourceHash, outputPath: outputFor(relativePath), evidence, facts: structuralFacts(text), status: index < 0 ? 'pending' : 'pending' }
}

export function makeEvidence(relativePath: string, text: string): EvidenceChunk[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const chunks: EvidenceChunk[] = []
  for (let offset = 0; offset < lines.length; offset += EVIDENCE_LINES) {
    const startLine = offset + 1; const endLine = Math.min(lines.length, offset + EVIDENCE_LINES)
    const chunkText = lines.slice(offset, endLine).join('\n')
    const contentHash = hash(chunkText)
    const id = `ev_${stableDigest({ relativePath, startLine, endLine, contentHash }).slice(0, 24)}`
    chunks.push({ id, relativePath, startLine, endLine, contentHash, text: chunkText })
  }
  return chunks
}

export function structuralFacts(text: string): { exports: string[]; imports: string[]; lineCount: number } {
  const exports = new Set<string>(); const imports = new Set<string>()
  for (const match of text.matchAll(/\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g)) exports.add(match[1])
  for (const match of text.matchAll(/\bexport\s*\{([^}]+)\}/g)) for (const part of match[1].split(',')) exports.add(part.trim().split(/\s+as\s+/)[0].trim())
  for (const match of text.matchAll(/\b(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g)) imports.add(match[1])
  return { exports: [...exports].filter(Boolean).sort(), imports: [...imports].sort(), lineCount: text.replace(/\r\n/g, '\n').split('\n').length }
}

export function outputFor(relativePath: string): string {
  const extension = extname(relativePath); const leaf = basename(relativePath, extension)
  const folder = dirname(relativePath); const result = folder === '.' ? `${leaf}.md` : `${folder}/${leaf}.md`
  return safeRelative(result)
}

export function chooseSamples(items: SpecModule[]): string[] {
  if (items.length < 3) throw new Error('至少需要三個模組供校準樣本')
  const scored = items.map(item => ({ item, score: item.facts.exports.length * 10 + item.facts.imports.length * 4 + Math.min(item.facts.lineCount, 100) / 100 }))
  const selected: SpecModule[] = [[...scored].sort((a, b) => b.score - a.score || a.item.relativePath.localeCompare(b.item.relativePath))[0].item]
  const importRich = [...scored].sort((a, b) => b.item.facts.imports.length - a.item.facts.imports.length || a.item.relativePath.localeCompare(b.item.relativePath)).find(candidate => !selected.some(chosen => chosen.id === candidate.item.id))?.item
  if (importRich) selected.push(importRich)
  const next = [...items].sort((a, b) => a.facts.lineCount - b.facts.lineCount || a.relativePath.localeCompare(b.relativePath)).find(item => !selected.some(chosen => chosen.id === item.id))
  if (next) selected.push(next)
  for (const item of items) if (selected.length < 3 && !selected.some(chosen => chosen.id === item.id)) selected.push(item)
  return selected.slice(0, 3).map(item => item.id)
}

export function summarizeSpecItems(items: SpecModule[]): SpecBatchSummary {
  const count = (status: SpecModule['status']) => items.filter(item => item.status === status).length
  return { total: items.length, pending: count('pending'), sampleReady: count('sample-ready'), approved: count('approved'), ready: count('ready'), applied: count('applied'), needsReview: count('needs-review'), rejected: count('rejected'), failed: count('failed') }
}

/** Status and apply outcomes are omitted so a durable interrupted batch retains its reviewed identity. */
export function withSpecDigest(batch: Omit<SpecBatch, 'digest'> & { digest?: string }): SpecBatch {
  const digest = stableDigest({ version: batch.version, id: batch.id, revision: batch.revision, createdAt: batch.createdAt, sourceRoot: batch.sourceRoot, outputRoot: batch.outputRoot, recipe: batch.recipe, discovery: batch.discovery, samples: batch.samples, items: batch.items.map(item => ({ id: item.id, source: item.source, relativePath: item.relativePath, sourceHash: item.sourceHash, outputPath: item.outputPath, evidence: item.evidence, facts: item.facts, draft: item.draft, renderedMarkdown: item.renderedMarkdown, renderedHash: item.renderedHash, approvedMarkdown: item.approvedMarkdown, generation: item.generation && { ...item.generation, cached: undefined } })) })
  return { ...batch, digest } as SpecBatch
}

export function assertOutputCollisions(items: SpecModule[]): void { const seen = new Set<string>(); for (const item of items) { const value = safeRelative(item.outputPath).replace(/[\\/]/g, '/').toLocaleLowerCase('en-US'); if (seen.has(value)) throw new Error(`兩個模組會寫入同一規格檔：${item.outputPath}`); seen.add(value) } }

export function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex') }
export function normalizeInstructions(value: string): string { if (typeof value !== 'string' || value.length > 8_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error('批次說明不正確'); return value.trim() }

async function collectSourceFiles(root: string, max: number, stateRoot?: string): Promise<{ files: string[]; discovery: SpecDiscovery }> {
  const files: string[] = []
  const excluded: SpecExclusion[] = []; const counts: Record<SpecExclusion['reason'], number> = { 'ignored-folder': 0, 'state-folder': 0, 'non-code': 0, 'declaration-file': 0, 'too-large': 0, symlink: 0 }
  const exclude = (path: string, reason: SpecExclusion['reason']) => { counts[reason]++; if (excluded.length < 200) excluded.push({ relativePath: path.split(sep).join('/'), reason }) }
  async function walk(folder: string): Promise<void> {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const candidate = join(folder, entry.name); const relativePath = relative(root, candidate)
      if (stateRoot && samePath(candidate, stateRoot)) { exclude(relativePath, 'state-folder'); continue }
      const info = await lstat(candidate)
      if (info.isSymbolicLink()) { exclude(relativePath, 'symlink'); continue }
      const actual = await realpath(candidate)
      if (!within(root, actual) && !samePath(root, actual)) { exclude(relativePath, 'symlink'); continue }
      if (info.isDirectory()) { if (IGNORED_FOLDERS.has(entry.name)) exclude(relativePath, 'ignored-folder'); else await walk(actual); continue }
      if (!info.isFile()) continue
      if (entry.name.endsWith('.d.ts')) { exclude(relativePath, 'declaration-file'); continue }
      if (!EXTENSIONS.has(extname(entry.name).toLowerCase())) { exclude(relativePath, 'non-code'); continue }
      if (info.size > MAX_SOURCE_BYTES) { exclude(relativePath, 'too-large'); continue }
      files.push(actual); if (files.length > max) throw new Error(`批次超過 ${max} 個模組`)
    }
  }
  await walk(root); files.sort((a, b) => a.localeCompare(b)); excluded.sort((a, b) => a.relativePath.localeCompare(b.relativePath)); return { files, discovery: { inScope: files.length, excludedTotal: Object.values(counts).reduce((sum, count) => sum + count, 0), excludedByReason: counts, excluded } }
}
