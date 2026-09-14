import { createHash, randomUUID } from 'node:crypto'
import { basename, extname, join, normalize, relative, sep } from 'node:path'
import type { Plan, Recipe } from './types.js'

const INVALID_CHARACTER = /[<>:"|?*\u0000-\u001f]/
const TOKEN = /\{(stem|ext|index|class)\}/g
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

export function defaultRecipe(name = '我的整理方式'): Recipe {
  return { version: 1, id: randomUUID(), name, createdAt: new Date().toISOString(), pattern: '{stem}', classification: { kind: 'folder-prefix' } }
}

export function classify(relativePath: string): string {
  const extension = extname(relativePath).toLowerCase()
  if (['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'].includes(extension)) return '文件'
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(extension)) return '圖片'
  if (['.txt', '.md', '.csv'].includes(extension)) return '文字'
  return '其他'
}

export function validateRecipe(recipe: Recipe): void {
  if (!recipe || recipe.version !== 1 || !isSafeId(recipe.id) || !isHumanName(recipe.name) || typeof recipe.createdAt !== 'string' || Number.isNaN(Date.parse(recipe.createdAt)) || typeof recipe.pattern !== 'string' || recipe.pattern.length === 0 || recipe.pattern.length > 180 || !['folder-prefix', 'none'].includes(recipe.classification?.kind)) throw new Error('Invalid recipe')
  if (recipe.classification.folders && Object.values(recipe.classification.folders).some(folder => typeof folder !== 'string' || folder.length > 100 || !isSafeSegment(folder))) throw new Error('Invalid recipe folder')
  if (recipe.overrides && (Object.keys(recipe.overrides).length > 1_000 || Object.entries(recipe.overrides).some(([source, destination]) => !isSafeRelativeSource(source) || typeof destination !== 'string' || safeRelative(destination) !== destination))) throw new Error('Invalid recipe override')
}

export function recipeFromPlan(plan: Plan, name: string): Recipe {
  if (!isHumanName(name)) throw new Error('Recipe name must be 1–80 characters')
  const overrides: Record<string, string> = {}
  for (const [index, item] of plan.items.entries()) {
    const proposed = destinationFor({ ...plan.recipe, overrides: undefined }, item.relativePath, index).destination
    if (item.destination !== proposed) overrides[item.relativePath] = item.destination
  }
  const { overrides: _priorOverrides, ...baseRecipe } = plan.recipe
  return { ...baseRecipe, id: randomUUID(), name: name.trim(), createdAt: new Date().toISOString(), ...(Object.keys(overrides).length ? { overrides } : {}) }
}

export function destinationFor(recipe: Recipe, sourceRelative: string, index: number): { destination: string; classification: string } {
  validateRecipe(recipe)
  if (!isSafeRelativeSource(sourceRelative)) throw new Error('Invalid source-relative path')
  const sourceName = basename(sourceRelative)
  const extension = extname(sourceName)
  const stem = sourceName.slice(0, sourceName.length - extension.length)
  const classification = classify(sourceRelative)
  const override = recipe.overrides?.[sourceRelative]
  if (override !== undefined) return { destination: validateDestinationExtension(override, extension), classification }
  const rendered = recipe.pattern.replace(TOKEN, (_whole, token: string) => ({ stem, ext: extension.replace(/^\./, ''), index: String(index + 1), class: classification })[token] ?? '')
  const leaf = rendered.endsWith(extension) ? rendered : `${rendered}${extension}`
  if (!isSafeSegment(leaf)) throw new Error(`Recipe produced an unsafe filename: ${leaf}`)
  const folder = recipe.classification.kind === 'folder-prefix' ? (recipe.classification.folders?.[classification] ?? classification) : ''
  if (folder !== '' && !isSafeSegment(folder)) throw new Error('Recipe produced an unsafe folder')
  return { destination: folder === '' ? leaf : join(folder, leaf), classification }
}

/** Validates a user destination as an output-root-relative path. */
export function safeRelative(value: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 320 || value.includes('\0')) throw new Error('Destination must be a non-empty relative path')
  if (/^[\\/]/.test(value) || /^[a-z]:/i.test(value)) throw new Error(`Destination escapes its output folder: ${value}`)
  const normalized = normalize(value)
  if (normalized === '.' || normalized === '..' || normalized.startsWith(`..${sep}`) || relative('.', normalized).startsWith(`..${sep}`)) throw new Error(`Destination escapes its output folder: ${value}`)
  const segments = normalized.split(/[\\/]/)
  if (segments.length === 0 || segments.some(segment => !isSafeSegment(segment))) throw new Error(`Destination contains an unsafe path segment: ${value}`)
  return normalized
}

export function validateDestinationExtension(destination: string, sourceExtension: string): string {
  const safe = safeRelative(destination)
  if (extname(basename(safe)) !== sourceExtension) throw new Error(`Destination must keep the original ${sourceExtension || 'file'} extension`)
  return safe
}

export function isSafeId(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f-]{16,64}$/i.test(value) }

export function stableDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(sortValue(value))).digest('hex')
}

function isHumanName(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 80 && !/[\u0000-\u001f]/.test(value) }
function isSafeRelativeSource(value: string): boolean { try { return safeRelative(value) === value } catch { return false } }
function isSafeSegment(value: string): boolean { return value.length > 0 && value !== '.' && value !== '..' && !INVALID_CHARACTER.test(value) && !/[\\/]/.test(value) && !/[. ]$/.test(value) && !WINDOWS_DEVICE.test(value) }

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sortValue(child)]))
  return value
}
