import { createHash, randomUUID } from 'node:crypto'
import { basename, extname, isAbsolute, join, normalize, relative, sep } from 'node:path'
import { RE2 } from 're2-wasm'
import { validateSidecar } from './artifacts.js'
import type { Plan, ProposalExceptionCode, Recipe, RecipeV1, RecipeV2 } from './types.js'

const INVALID_CHARACTER = /[<>:"|?*\u0000-\u001f]/
const V1_TOKEN = /\{(stem|ext|index|class)\}/g
const V2_TOKEN = /\{(stem|ext|index|class|match\.[A-Za-z][A-Za-z0-9_]*)\}/g
const ANY_TOKEN = /\{([^{}]+)\}/g
const WINDOWS_DEVICE = /^(con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\..*)?$/i
const GROUP_NAME = /\(\?<([A-Za-z][A-Za-z0-9_]*)>/g

export class ProposalError extends Error {
  constructor(readonly code: Exclude<ProposalExceptionCode, 'collision'>, message: string) { super(message) }
}

export function defaultRecipe(name = 'Default rule'): RecipeV1 {
  return { version: 1, id: randomUUID(), name, createdAt: new Date().toISOString(), pattern: '{stem}', classification: { kind: 'folder-prefix' } }
}

export function defaultRecipeV2(name = 'Default rule'): RecipeV2 {
  return { version: 2, id: randomUUID(), name, createdAt: new Date().toISOString(), pattern: '{stem}', classification: { kind: 'folder-prefix' } }
}

/** Deterministic classification by extension. It is a grouping rule, not content understanding. */
export function classify(relativePath: string): string {
  const extension = extname(relativePath).toLowerCase()
  if (['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'].includes(extension)) return 'documents'
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(extension)) return 'images'
  if (['.txt', '.md', '.csv'].includes(extension)) return 'text'
  return 'other'
}

export function validateRecipe(recipe: Recipe): void {
  if (!recipe || ![1, 2].includes(recipe.version) || !isSafeId(recipe.id) || !isHumanName(recipe.name) || typeof recipe.createdAt !== 'string' || Number.isNaN(Date.parse(recipe.createdAt)) || typeof recipe.pattern !== 'string' || recipe.pattern.length === 0 || recipe.pattern.length > 320 || !['folder-prefix', 'none'].includes(recipe.classification?.kind)) throw new Error('Invalid recipe')
  if (recipe.classification.folders && Object.values(recipe.classification.folders).some(folder => typeof folder !== 'string' || folder.length > 100 || !isSafeSegment(folder))) throw new Error('Invalid recipe folder')
  if (recipe.overrides && (Object.keys(recipe.overrides).length > 10_000 || Object.entries(recipe.overrides).some(([source, destination]) => !isContainedRelativeSource(source) || typeof destination !== 'string' || safeRelative(destination) !== destination))) throw new Error('Invalid recipe override')
  if (recipe.sidecars !== undefined) {
    if (!Array.isArray(recipe.sidecars)) throw new Error('Invalid recipe sidecars')
    for (const spec of recipe.sidecars) validateSidecar(spec)
  }
  if (recipe.archive !== undefined) {
    if (!recipe.archive || recipe.archive.kind !== 'zip') throw new Error("The only supported archive kind is 'zip'")
    if (typeof recipe.archive.destination !== 'string' || recipe.archive.destination === '') throw new Error('The archive destination must be an output-root-relative path')
    validateDestinationExtension(recipe.archive.destination, '.zip')
  }
  if (recipe.version === 1) {
    if (recipe.pattern.length > 180 || /[\\/]/.test(recipe.pattern)) throw new Error('Version 1 recipes support flat filename templates only')
    return
  }
  validateV2Template(recipe)
  if (recipe.match !== undefined) validateMatch(recipe.match.regex, recipe.match.scope, recipe.match.flags)
}

/**
 * Validates a deliberately small, linear-time-compatible regex grammar.
 * It permits anchors, named capture groups, literals, dots, character classes,
 * and atom quantifiers. Alternation, nesting, quantified groups, lookarounds,
 * backreferences, and counted quantifiers are rejected before RegExp is built.
 */
export function validateMatch(regex: string, scope: 'basename' | 'relative-path', flags = ''): string[] {
  if (typeof regex !== 'string' || regex.length === 0 || regex.length > 256) throw new Error('match_regex must be 1–256 characters')
  if (scope !== 'basename' && scope !== 'relative-path') throw new Error("match_scope must be 'basename' or 'relative-path'")
  if (typeof flags !== 'string' || !/^(?:iu|ui|i|u)?$/.test(flags)) throw new Error("match_flags may contain only 'i' and 'u', without duplicates")
  if (!regex.startsWith('^') || !hasUnescapedTerminalDollar(regex)) throw new Error('match_regex must be anchored with ^ and $')
  validateRegexBody(regex.slice(1, -1))
  try { void new RE2(regex, flags.includes('u') ? flags : `${flags}u`) } catch { throw new Error('match_regex is not a valid RE2 regular expression') }
  return [...regex.matchAll(GROUP_NAME)].map(match => match[1]!)
}

export function recipeFromPlan(plan: Plan, name: string): Recipe {
  if (!isHumanName(name)) throw new Error('Recipe name must be 1–80 characters')
  const overrides = explicitOverrides(plan)
  const { overrides: _priorOverrides, ...baseRecipe } = plan.recipe
  return { ...baseRecipe, id: randomUUID(), name: name.trim(), createdAt: new Date().toISOString(), ...(Object.keys(overrides).length ? { overrides } : {}) } as Recipe
}

export function explicitOverrides(plan: Pick<Plan, 'recipe' | 'items'>): Record<string, string> {
  const overrides: Record<string, string> = {}
  const base = { ...plan.recipe, overrides: undefined } as Recipe
  for (const [index, item] of plan.items.entries()) {
    if (!item.destination || item.proposalDisposition === 'exception') continue
    try {
      const proposed = destinationFor(base, item.relativePath, index).destination
      if (item.destination !== proposed) overrides[item.relativePath] = item.destination
    } catch { overrides[item.relativePath] = item.destination }
  }
  return overrides
}

export function destinationFor(recipe: Recipe, sourceRelative: string, index: number): { destination: string; classification: string; captures: Record<string, string> } {
  validateRecipe(recipe)
  if (!isContainedRelativeSource(sourceRelative)) throw new ProposalError('invalid-destination', 'Invalid source-relative path')
  const sourceName = basename(sourceRelative)
  const extension = extname(sourceName)
  const stem = sourceName.slice(0, sourceName.length - extension.length)
  const classification = classify(sourceRelative)
  const override = recipe.overrides?.[sourceRelative]
  if (override !== undefined) return { destination: checkedDestination(override, extension), classification, captures: {} }
  if (recipe.version === 1) return destinationForV1(recipe, sourceRelative, index, classification)

  const captures: Record<string, string> = {}
  if (recipe.match) {
    const input = recipe.match.scope === 'basename' ? sourceName : sourceRelative.replace(/\\/g, '/')
    const maximum = recipe.match.scope === 'basename' ? 512 : 4096
    if (input.length > maximum) throw new ProposalError('unmatched', 'Match input exceeds the safe filesystem length bound')
    const re2Flags = recipe.match.flags.includes('u') ? recipe.match.flags : `${recipe.match.flags}u`
    const match = new RE2(recipe.match.regex, re2Flags).exec(input)
    if (!match) throw new ProposalError('unmatched', 'Unmatched source: the filename does not match match_regex')
    for (const [name, value] of Object.entries(match.groups ?? {})) {
      if (value === undefined) throw new ProposalError('unmatched', `Named capture did not participate: ${name}`)
      captures[name] = value
    }
  }
  // In a v2 template `{ext}` renders the extension *with* its dot so that
  // `{match.code}{ext}` is a correct file name. v1 keeps its frozen, dotless
  // semantics; converting a v1 pattern that relies on them is refused below.
  const values: Record<string, string> = { stem, ext: extension, index: String(index + 1), class: classification }
  const rendered = recipe.pattern.replace(V2_TOKEN, (_whole, token: string) => token.startsWith('match.') ? requireCapture(captures, token.slice(6)) : values[token] ?? '')
  const candidate = rendered.endsWith(extension) ? rendered : `${rendered}${extension}`
  const folder = recipe.classification.kind === 'folder-prefix' ? (recipe.classification.folders?.[classification] ?? classification) : ''
  if (folder !== '' && !isSafeSegment(folder)) throw new ProposalError('invalid-destination', 'Recipe produced an unsafe classification folder')
  const destination = folder === '' ? candidate : join(folder, candidate)
  return { destination: checkedDestination(destination, extension), classification, captures }
}

function destinationForV1(recipe: RecipeV1, sourceRelative: string, index: number, classification: string): { destination: string; classification: string; captures: Record<string, string> } {
  const sourceName = basename(sourceRelative)
  const extension = extname(sourceName)
  const stem = sourceName.slice(0, sourceName.length - extension.length)
  const rendered = recipe.pattern.replace(V1_TOKEN, (_whole, token: string) => ({ stem, ext: extension.replace(/^\./, ''), index: String(index + 1), class: classification })[token] ?? '')
  const leaf = rendered.endsWith(extension) ? rendered : `${rendered}${extension}`
  if (!isSafeSegment(leaf)) throw new ProposalError('invalid-destination', `Recipe produced an unsafe filename: ${leaf}`)
  const folder = recipe.classification.kind === 'folder-prefix' ? (recipe.classification.folders?.[classification] ?? classification) : ''
  if (folder !== '' && !isSafeSegment(folder)) throw new ProposalError('invalid-destination', 'Recipe produced an unsafe folder')
  return { destination: folder === '' ? leaf : join(folder, leaf), classification, captures: {} }
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

function checkedDestination(destination: string, extension: string): string {
  try { return validateDestinationExtension(destination, extension) } catch (error: unknown) { throw new ProposalError('invalid-destination', error instanceof Error ? error.message : 'Invalid destination') }
}

function validateV2Template(recipe: RecipeV2): void {
  const knownGroups = new Set(recipe.match ? validateMatch(recipe.match.regex, recipe.match.scope, recipe.match.flags) : [])
  for (const match of recipe.pattern.matchAll(ANY_TOKEN)) {
    const token = match[1]!
    if (['stem', 'ext', 'index', 'class'].includes(token)) continue
    if (!token.startsWith('match.') || !knownGroups.has(token.slice(6))) throw new Error(`Unknown or unavailable destination template token: {${token}}`)
  }
  if (/[{}]/.test(recipe.pattern.replace(V2_TOKEN, ''))) throw new Error('Destination template contains an unknown token or literal brace')
  if (!recipe.match && recipe.pattern.includes('{match.')) throw new Error('A match_regex is required when the template uses named captures')
}

function requireCapture(captures: Record<string, string>, name: string): string {
  if (!(name in captures)) throw new ProposalError('invalid-destination', `Destination template capture is unavailable: ${name}`)
  const value = captures[name]!
  // A capture is inserted as exactly one path segment: it can never add
  // directory structure, a drive prefix, or a reserved name of its own.
  if (!isSafeSegment(value)) throw new ProposalError('unsafe-capture', `Named capture is not one safe path segment: ${name}`)
  return value
}

function validateRegexBody(body: string): void {
  if (body.length === 0) return
  let index = 0
  let previousWasAtom = false
  let previousWasQuantifier = false
  while (index < body.length) {
    const character = body[index]!
    if (['|', '{', '}', '^', '$'].includes(character)) throw new Error('match_regex uses an unsupported construct')
    if (['*', '+', '?'].includes(character)) {
      if (!previousWasAtom || previousWasQuantifier) throw new Error('match_regex has an invalid or nested quantifier')
      previousWasQuantifier = true
      index++
      continue
    }
    if (character === '(') {
      if (!body.startsWith('(?<', index)) throw new Error('match_regex permits named capture groups only')
      const headerEnd = body.indexOf('>', index + 3)
      if (headerEnd < 0 || !/^[A-Za-z][A-Za-z0-9_]*$/.test(body.slice(index + 3, headerEnd))) throw new Error('match_regex has an invalid named capture')
      const close = findGroupClose(body, headerEnd + 1)
      validateRegexAtoms(body.slice(headerEnd + 1, close))
      if (['*', '+', '?', '{'].includes(body[close + 1] ?? '')) throw new Error('match_regex cannot quantify a capture group')
      previousWasAtom = true
      previousWasQuantifier = false
      index = close + 1
      continue
    }
    if (character === ')') throw new Error('match_regex has an unmatched group delimiter')
    const next = consumeAtom(body, index)
    previousWasAtom = true
    previousWasQuantifier = false
    index = next
  }
}

function validateRegexAtoms(body: string): void {
  if (body.length === 0) throw new Error('match_regex named captures cannot be empty')
  let index = 0
  let previousWasAtom = false
  let previousWasQuantifier = false
  while (index < body.length) {
    const character = body[index]!
    if (['(', ')', '|', '{', '}', '^', '$'].includes(character)) throw new Error('match_regex capture contains an unsupported construct')
    if (['*', '+', '?'].includes(character)) {
      if (!previousWasAtom || previousWasQuantifier) throw new Error('match_regex has an invalid or nested quantifier')
      previousWasQuantifier = true
      index++
      continue
    }
    index = consumeAtom(body, index)
    previousWasAtom = true
    previousWasQuantifier = false
  }
}

function consumeAtom(body: string, index: number): number {
  const character = body[index]!
  if (character === '\\') {
    const escaped = body[index + 1]
    if (!escaped || /[1-9k]/.test(escaped)) throw new Error('match_regex backreferences are not allowed')
    return index + 2
  }
  if (character !== '[') return index + 1
  let cursor = index + 1
  if (body[cursor] === '^') cursor++
  let content = 0
  for (; cursor < body.length; cursor++) {
    if (body[cursor] === '\\') { if (cursor + 1 >= body.length) throw new Error('match_regex has an unterminated escape'); cursor++; content++; continue }
    if (body[cursor] === ']') { if (content === 0) throw new Error('match_regex character classes cannot be empty'); return cursor + 1 }
    content++
  }
  throw new Error('match_regex has an unterminated character class')
}

function findGroupClose(body: string, start: number): number {
  let escaped = false
  let inClass = false
  for (let index = start; index < body.length; index++) {
    const character = body[index]!
    if (escaped) { escaped = false; continue }
    if (character === '\\') { escaped = true; continue }
    if (character === '[') { inClass = true; continue }
    if (character === ']' && inClass) { inClass = false; continue }
    if (!inClass && character === '(') throw new Error('match_regex nested groups are not allowed')
    if (!inClass && character === ')') return index
  }
  throw new Error('match_regex has an unterminated named capture')
}

function hasUnescapedTerminalDollar(value: string): boolean {
  if (!value.endsWith('$')) return false
  let slashes = 0
  for (let index = value.length - 2; index >= 0 && value[index] === '\\'; index--) slashes++
  return slashes % 2 === 0
}

function isContainedRelativeSource(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 32_000 || value.includes('\0') || isAbsolute(value)) return false
  const normalized = normalize(value)
  return normalized !== '.' && normalized !== '..' && !normalized.startsWith(`..${sep}`) && !normalized.startsWith('../')
}

function isHumanName(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 80 && !/[\u0000-\u001f]/.test(value) }
function isSafeSegment(value: string): boolean { return value.length > 0 && value.length <= 255 && value !== '.' && value !== '..' && !INVALID_CHARACTER.test(value) && !/[\\/]/.test(value) && !/[. ]$/.test(value) && !WINDOWS_DEVICE.test(value) }

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, sortValue(child)]))
  return value
}
