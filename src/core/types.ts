export type ItemStatus = 'ready' | 'applying' | 'applied' | 'rejected' | 'failed'
export type ProposalDisposition = 'ready' | 'exception'
export type ProposalExceptionCode = 'unmatched' | 'unsafe-capture' | 'invalid-destination' | 'collision'

export type SidecarKind = 'manifest' | 'checksums' | 'sql-insert'
export type SidecarFormat = 'csv' | 'json' | 'markdown'
/** Only dialects whose string-literal escaping is unambiguous are accepted. */
export type SqlDialect = 'sqlserver' | 'postgres' | 'sqlite'

export interface SqlInsertSpec {
  dialect: SqlDialect
  schema: string
  table: string
  columns: string[]
  /** One plain template string per column; values become escaped literals, never syntax. */
  values: Record<string, string>
}

export interface SidecarSpec {
  kind: SidecarKind
  /** Output-root-relative destination including a file extension. */
  destination: string
  format?: SidecarFormat
  sql?: SqlInsertSpec
}

/** A rendered, reviewed sidecar. Its bytes are part of the reviewed identity. */
export interface PlannedArtifact {
  id: string
  kind: SidecarKind
  destination: string
  renderer: string
  contentHash: string
  bytes: number
  status: 'ready' | 'applying' | 'applied' | 'failed' | 'rejected'
  reason?: string
}

export interface ArchiveSpec {
  kind: 'zip'
  /** Output-root-relative destination for the archive itself. */
  destination: string
}

export interface RecipeClassification {
  kind: 'folder-prefix' | 'none'
  folders?: Record<string, string>
}

export interface RecipeBase {
  id: string
  name: string
  createdAt: string
  pattern: string
  classification: RecipeClassification
  /** Reviewed per-source destination overrides, keyed by source-relative path. */
  overrides?: Record<string, string>
  /** Reviewed sidecars rendered with the batch. Declarative text only. */
  sidecars?: SidecarSpec[]
  /** Optional reviewed ZIP of every successful output. */
  archive?: ArchiveSpec
}

/** The 0.1 recipe format. Its flat filename-template semantics are frozen. */
export interface RecipeV1 extends RecipeBase { version: 1 }

export interface RecipeMatch {
  regex: string
  scope: 'basename' | 'relative-path'
  flags: string
}

/** The 0.2 declarative recipe format. Regex and templates are data only. */
export interface RecipeV2 extends RecipeBase {
  version: 2
  match?: RecipeMatch
}

export type Recipe = RecipeV1 | RecipeV2

export interface CopyIntent {
  destination: string
  sourceHash: string
  startedAt: string
}

export interface PlanItem {
  id: string
  source: string
  relativePath: string
  destination: string
  sourceHash: string
  classification: string
  /** Immutable reviewed proposal state. Included in the plan digest. */
  proposalDisposition: ProposalDisposition
  exceptionCode?: ProposalExceptionCode
  exceptionDetails?: string
  captures?: Record<string, string>
  /** Mutable apply state. Excluded from the plan digest. */
  status: ItemStatus
  reason?: string
  /** Mutable crash-recovery state. Excluded from the plan digest. */
  copyIntent?: CopyIntent
}

export interface PlanSummary {
  total: number
  ready: number
  exception: number
  applying: number
  applied: number
  rejected: number
  failed: number
}

export interface PlanDiagnostics {
  ready: number
  exceptions: number
  exceptionsByReason: Record<string, number>
  collisions: number
  unmatched: number
  artifactCount: number
}

export interface ArchiveState {
  /** Mutable crash-recovery state; excluded from the reviewed digest. */
  status: 'ready' | 'applying' | 'applied' | 'failed'
  contentHash?: string
  bytes?: number
  reason?: string
}

export interface Plan {
  version: 'm0'
  id: string
  revision: number
  /** SHA-256 identity of reviewed source snapshots and proposals. */
  digest: string
  createdAt: string
  sourceRoot: string
  destinationRoot: string
  recipe: Recipe
  items: PlanItem[]
  /**
   * Reviewed rendered sidecars. Their bytes are part of the digest. Plans
   * persisted before 0.2 have no such field, so every reader treats it as absent.
   */
  artifacts?: PlannedArtifact[]
  /** Optional reviewed archive of every successful output. */
  archive?: ArchiveSpec
  /** Mutable archive journal for exact-hash crash recovery. */
  archiveState?: ArchiveState
  summary: PlanSummary
  diagnostics: PlanDiagnostics
}

export interface ApplyResult {
  planId: string
  revision: number
  digest: string
  items: PlanItem[]
  artifacts: PlannedArtifact[]
  summary: PlanSummary
  /** Every path this apply produced or confirmed, for the agent to present. */
  deliverables: Deliverables
}

export interface Deliverables {
  outputRoot: string
  files: string[]
  sidecars: string[]
  archive?: string
}

export interface CreatePlanOptions {
  sourceRoot: string
  destinationRoot: string
  recipe: Recipe
  maxFiles?: number
  /** Internal state roots are forbidden from overlapping the source or output tree. */
  excludedRoots?: string[]
}

export interface PlanEdit { id: string; destination: string }

export interface RuleRevision {
  pattern?: string
  matchRegex?: string | null
  matchScope?: 'basename' | 'relative-path'
  matchFlags?: string
  classification?: 'folder-prefix' | 'none'
  preserveOverrides?: boolean
  /** Replace the reviewed sidecars. An empty array removes them. */
  sidecars?: SidecarSpec[]
  /** `null` removes the archive; omitted leaves it unchanged. */
  archive?: ArchiveSpec | null
}
