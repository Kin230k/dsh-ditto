import { createHash, randomUUID } from 'node:crypto'
import { basename, extname } from 'node:path'
import { classify, isSafeId, safeRelative, stableDigest, validateDestinationExtension } from './recipe.js'
import type { PlanItem, PlannedArtifact, SidecarFormat, SidecarSpec, SqlDialect } from './types.js'

/** Fixed, documented renderer identity. Any change here must change the digest. */
export const ARTIFACT_RENDERER = 'ditto-artifacts/2'

/** SHA-256 of the rendered UTF-8 bytes, so a sidecar hash can be rechecked from the file itself. */
export function contentHash(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex') }

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]{0,63}$/
const DIALECTS: readonly SqlDialect[] = ['sqlserver', 'postgres', 'sqlite']
const FORMATS: readonly SidecarFormat[] = ['csv', 'json', 'markdown']
const TEMPLATE_TOKEN = /\{(stem|ext|index|class|match\.[A-Za-z][A-Za-z0-9_]*)\}/g

export interface ArtifactContext {
  planId: string
  revision: number
  sourceRoot: string
  destinationRoot: string
  items: readonly PlanItem[]
}

/** Validates one declarative sidecar spec. No shell, script, or raw SQL is accepted. */
export function validateSidecar(spec: SidecarSpec): void {
  if (!spec || typeof spec !== 'object') throw new Error('Each sidecar must be an object')
  if (spec.kind !== 'manifest' && spec.kind !== 'checksums' && spec.kind !== 'sql-insert') throw new Error('sidecar kind must be manifest, checksums, or sql-insert')
  validateSidecarDestination(spec)
  if (spec.kind === 'manifest') {
    if (spec.format === undefined || !FORMATS.includes(spec.format)) throw new Error(`A manifest sidecar needs a format of ${FORMATS.join(', ')}`)
  } else if (spec.format !== undefined) {
    throw new Error('Only a manifest sidecar takes a format')
  }
  if (spec.kind === 'sql-insert') {
    const sql = spec.sql
    if (!sql || typeof sql !== 'object') throw new Error('A sql-insert sidecar needs a sql block')
    if (!DIALECTS.includes(sql.dialect)) throw new Error(`sql dialect must be ${DIALECTS.join(', ')}; other dialects have ambiguous literal escaping and are not supported`)
    if (!IDENTIFIER.test(sql.schema)) throw new Error('sql schema must be a plain identifier')
    if (!IDENTIFIER.test(sql.table)) throw new Error('sql table must be a plain identifier')
    if (!Array.isArray(sql.columns) || sql.columns.length === 0 || sql.columns.length > 32) throw new Error('sql columns must be 1–32 plain identifiers')
    if (new Set(sql.columns.map(column => column.toLocaleLowerCase('en-US'))).size !== sql.columns.length) throw new Error('sql columns must be unique')
    for (const column of sql.columns) if (!IDENTIFIER.test(column)) throw new Error(`sql column is not a plain identifier: ${column}`)
    if (!sql.values || typeof sql.values !== 'object' || Array.isArray(sql.values)) throw new Error('sql values must map every column to a template string')
    const valueColumns = Object.keys(sql.values)
    if (valueColumns.length !== sql.columns.length || sql.columns.some(column => !Object.hasOwn(sql.values, column))) throw new Error('sql values must provide exactly one template for every listed column')
    for (const [column, template] of Object.entries(sql.values)) {
      if (!sql.columns.includes(column)) throw new Error(`sql values name a column that is not in the column list: ${column}`)
      validateTemplate(template, `sql values.${column}`)
    }
  } else if (spec.sql !== undefined) {
    throw new Error('Only a sql-insert sidecar takes a sql block')
  }
}

/** Renders every configured sidecar deterministically. Same plan revision, same bytes. */
export function renderArtifacts(context: ArtifactContext, specs: readonly SidecarSpec[] | undefined): PlannedArtifact[] {
  if (!specs || specs.length === 0) return []
  if (!Array.isArray(specs) || specs.length > 8) throw new Error('A plan may configure at most 8 sidecars')
  const plans = specs.map(spec => { validateSidecar(spec); return spec })
  const destinations = new Set<string>()
  for (const spec of plans) {
    const key = collisionKey(spec.destination)
    if (destinations.has(key)) throw new Error(`Two sidecars would use the same destination: ${spec.destination}`)
    destinations.add(key)
  }
  for (const artifact of plans) {
    for (const item of context.items) {
      if (item.destination === '' || item.proposalDisposition === 'exception') continue
      if (overlaps(collisionKey(artifact.destination), collisionKey(item.destination))) throw new Error(`A sidecar destination collides with a reviewed file destination: ${artifact.destination}`)
    }
  }

  return plans.map(spec => {
    const content = render(spec, context.items, context)
    return {
      id: stableDigest(`${spec.kind}:${spec.destination}:${stableDigest(spec)}`).slice(0, 16),
      kind: spec.kind,
      destination: spec.destination,
      renderer: ARTIFACT_RENDERER,
      contentHash: contentHash(content),
      bytes: Buffer.byteLength(content, 'utf8'),
      status: 'ready' as const,
    }
  })
}

/** Re-renders one artifact and proves the bytes still match the reviewed hash. */
export function reviewArtifact(artifact: PlannedArtifact, context: ArtifactContext, specs: readonly SidecarSpec[] | undefined): string {
  const spec = (specs ?? []).find(candidate => candidate.destination === artifact.destination)
  if (!spec) throw new Error('The reviewed sidecar rule is no longer part of this plan')
  const content = renderSidecarContent(spec, context)
  if (contentHash(content) !== artifact.contentHash) throw new Error('The sidecar no longer renders to the reviewed bytes; create a new preview')
  return content
}

/** Renders one sidecar's deterministic bytes without a hash comparison. */
export function renderSidecarContent(spec: SidecarSpec, context: ArtifactContext): string {
  validateSidecar(spec)
  return render(spec, context.items, context)
}

export function artifactKindFormat(spec: SidecarSpec): string { return spec.kind === 'manifest' ? `manifest/${spec.format}` : spec.kind }

function validateSidecarDestination(spec: SidecarSpec): void {
  if (typeof spec.destination !== 'string' || spec.destination.trim() === '') throw new Error('Each sidecar needs an output-root-relative destination')
  const safe = safeRelative(spec.destination)
  if (safe !== spec.destination.replace(/\\/g, '/')) throw new Error(`A sidecar destination must be a plain output-root-relative path: ${spec.destination}`)
  if (extname(basename(safe)) === '') throw new Error(`A sidecar destination needs a file extension: ${spec.destination}`)
}

function validateTemplate(value: unknown, label: string): void {
  if (typeof value !== 'string' || value.length > 400 || value.includes('\0')) throw new Error(`${label} must be a plain template string of up to 400 characters`)
  if (/[{}]/.test(value.replace(TEMPLATE_TOKEN, ''))) throw new Error(`${label} contains an unknown template token or a literal brace`)
}

function render(spec: SidecarSpec, items: readonly PlanItem[], context: ArtifactContext): string {
  if (spec.kind === 'manifest') return renderManifest(spec, items, context)
  // Plans persisted before 0.2 have no disposition field; every one of their
  // items is copyable, so only an explicit exception is excluded here.
  const copyable = items.filter(item => item.proposalDisposition !== 'exception' && item.destination !== '')
  if (spec.kind === 'checksums') return renderChecksums(copyable)
  return renderSql(spec, copyable)
}

function renderManifest(spec: SidecarSpec, items: readonly PlanItem[], context: ArtifactContext): string {
  const rows = items.map(item => ({
    source: normalize(item.relativePath),
    destination: normalize(item.destination),
    sha256: item.sourceHash,
    classification: normalize(item.classification),
    disposition: item.proposalDisposition,
    // Sidecar bytes are part of the reviewed digest and must not change as apply
    // journals mutable outcomes. This is the reviewed proposal status.
    status: item.proposalDisposition === 'exception' ? 'exception' : 'ready',
    exceptionCode: item.exceptionCode ?? '',
    exceptionDetails: item.exceptionDetails ?? '',
  }))
  if (spec.format === 'json') {
    // Key order and UTF-8 encoding are fixed; nothing here depends on locale or clock.
    return `${JSON.stringify({ planId: context.planId, revision: context.revision, renderer: ARTIFACT_RENDERER, items: rows }, null, 2)}\n`
  }
  if (spec.format === 'csv') {
    const header = ['source', 'destination', 'sha256', 'classification', 'disposition', 'status', 'exception_code', 'exception_details']
    const lines = [header.join(','), ...rows.map(row => [row.source, row.destination, row.sha256, row.classification, row.disposition, row.status, row.exceptionCode, row.exceptionDetails].map(csvCell).join(','))]
    return `${lines.join('\n')}\n`
  }
  const lines = [
    `# Ditto review manifest`,
    '',
    `- plan: \`${markdownCell(context.planId)}\``,
    `- revision: ${context.revision}`,
    `- renderer: \`${ARTIFACT_RENDERER}\``,
    `- source root: \`${markdownCell(context.sourceRoot)}\``,
    `- output root: \`${markdownCell(context.destinationRoot)}\``,
    `- sources: ${rows.length}`,
    '',
    '| source | destination | sha256 | classification | disposition | status | exception | details |',
    '|---|---|---|---|---|---|---|---|',
    ...rows.map(row => `| ${markdownCell(row.source)} | ${markdownCell(row.destination)} | \`${row.sha256}\` | ${markdownCell(row.classification)} | ${row.disposition} | ${row.status} | ${markdownCell(row.exceptionCode)} | ${markdownCell(row.exceptionDetails)} |`),
    '',
  ]
  return lines.join('\n')
}

function renderChecksums(items: readonly PlanItem[]): string {
  return `${items.map(item => `${item.sourceHash}  ${normalize(item.destination)}`).join('\n')}\n`
}

function renderSql(spec: SidecarSpec, items: readonly PlanItem[]): string {
  const sql = spec.sql!
  const quote = sql.dialect === 'sqlserver' ? (value: string) => `[${value}]` : (value: string) => `"${value}"`
  const literal = (value: string) => {
    const escaped = value.replace(/'/g, "''")
    return sql.dialect === 'sqlserver' ? `N'${escaped}'` : `'${escaped}'`
  }
  const header = `INSERT INTO ${quote(sql.schema)}.${quote(sql.table)} (${sql.columns.map(quote).join(', ')}) VALUES`
  const lines = items.map((item, index) => {
    const values = sql.columns.map(column => literal(renderValue(sql.values[column]!, item, index)))
    return `${header} (${values.join(', ')});`
  })
  return `${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`
}

function renderValue(template: string, item: PlanItem, index: number): string {
  const extension = extname(basename(item.relativePath))
  const stem = basename(item.relativePath).slice(0, basename(item.relativePath).length - extension.length)
  const values: Record<string, string> = { stem, ext: extension, index: String(index + 1), class: classify(item.relativePath) }
  return template.replace(TEMPLATE_TOKEN, (_whole, token: string) => {
    if (!token.startsWith('match.')) return values[token] ?? ''
    const name = token.slice(6)
    const value = item.captures?.[name]
    if (value === undefined) throw new Error(`A sql template references the capture {match.${name}}, which this source did not produce`)
    return value
  })
}

/** Spreadsheet formula injection and control characters are neutralised, then the cell is RFC 4180 quoted. */
function csvCell(value: string): string {
  const printable = stripControl(value)
  const guarded = /^[=+\-@\t\r]/.test(printable) ? `'${printable}` : printable
  return `"${guarded.replace(/"/g, '""')}"`
}

function markdownCell(value: string): string {
  return stripControl(value).replace(/([\\`|*_<>\[\]&])/g, '\\$1')
}

function stripControl(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
}

function normalize(value: string): string { return value.replace(/\\/g, '/') }
function collisionKey(value: string): string { return safeRelative(value).replace(/\\/g, '/').toLocaleLowerCase('en-US') }
function overlaps(a: string, b: string): boolean { return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`) }

export function newArtifactId(spec: SidecarSpec): string { return `${stableDigest(spec).slice(0, 16)}-${randomUUID().slice(0, 8)}` }

export { isSafeId, validateDestinationExtension }
