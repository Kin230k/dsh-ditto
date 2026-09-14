export type ItemStatus = 'ready' | 'applied' | 'rejected' | 'failed'

export interface Recipe {
  version: 1
  id: string
  name: string
  createdAt: string
  /** Filename template: {stem}, {ext}, {index}, and {class}. */
  pattern: string
  classification: { kind: 'folder-prefix' | 'none'; folders?: Record<string, string> }
  /** Reviewed per-source destination overrides, keyed by source-relative path. */
  overrides?: Record<string, string>
}

export interface PlanItem {
  id: string
  source: string
  relativePath: string
  destination: string
  sourceHash: string
  classification: string
  status: ItemStatus
  reason?: string
}

export interface PlanSummary { total: number; ready: number; applied: number; rejected: number; failed: number }

export interface Plan {
  version: 'm0'
  id: string
  revision: number
  /** SHA-256 identity of the reviewed source snapshots and destinations.
   * It deliberately excludes mutable apply outcomes, so a crashed batch can resume
   * only with the same reviewed identity. */
  digest: string
  createdAt: string
  sourceRoot: string
  destinationRoot: string
  recipe: Recipe
  items: PlanItem[]
  summary: PlanSummary
}

export interface ApplyResult { planId: string; revision: number; digest: string; items: PlanItem[]; summary: PlanSummary }
export interface CreatePlanOptions {
  sourceRoot: string
  destinationRoot: string
  recipe: Recipe
  maxFiles?: number
  /** Existing internal state directories to omit when they are inside the source tree. */
  excludedRoots?: string[]
}
export interface PlanEdit { id: string; destination: string }
