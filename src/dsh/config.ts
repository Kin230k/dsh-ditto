import { isAbsolute, resolve } from 'node:path'
import { assertNoLinkAncestorSync, canonicalPathSync, within } from '../core/paths.js'

/** Configuration supplied by the profile owner, never by the model. */
export interface DshDittoConfig {
  /** Durable plans, batches, and recipes. Relative values are workspace-anchored and must stay inside workspaceRoot. Default: `.dsh-ditto`. */
  stateRoot?: string
  /** Workspace boundary used by relative paths and always used by Code-to-Spec. Default: the DSH process working directory. */
  workspaceRoot?: string
  /** Canonical roots from which file-organisation sources may be read. Default: `[workspaceRoot]`. */
  allowedSourceRoots?: string[]
  /** Canonical roots beneath which file-organisation outputs may be created. Default: `[workspaceRoot]`. */
  allowedDestinationRoots?: string[]
  /** How apply obtains approval. */
  approval?: 'host' | 'agent'
  /** Host `unavailable` policy: deny by default; `agent` is an explicit profile-owner conversational-approval fallback. */
  approvalUnavailable?: 'deny' | 'agent'
  /** Maximum source files a model may ask one file-organisation preview to enumerate (1–1,000). */
  maxItems?: number
  /** Maximum item records returned by one native tool response (1–100). */
  resultItems?: number
  /** Maximum source-evidence chunks returned by one spec-module request (1–40). */
  evidenceItems?: number
}

export interface ResolvedConfig {
  stateRoot: string
  workspaceRoot: string
  allowedSourceRoots: string[]
  allowedDestinationRoots: string[]
  approval: 'host' | 'agent'
  approvalUnavailable: 'deny' | 'agent'
  maxItems: number
  resultItems: number
  evidenceItems: number
}

export const DEFAULT_CONFIG = { stateRoot: '.dsh-ditto', approval: 'host', approvalUnavailable: 'deny', maxItems: 200, resultItems: 25, evidenceItems: 20 } as const

export function resolveConfig(config: DshDittoConfig): ResolvedConfig {
  const workspaceRoot = canonicalPathSync(config.workspaceRoot ?? process.cwd())
  const stateInput = config.stateRoot ?? DEFAULT_CONFIG.stateRoot
  const stateRoot = canonicalPathSync(isAbsolute(stateInput) ? stateInput : resolve(workspaceRoot, stateInput))
  if (!within(workspaceRoot, stateRoot, true)) throw new Error('Ditto stateRoot must stay inside workspaceRoot')
  assertNoLinkAncestorSync(stateRoot, 'Ditto stateRoot must not use a symlink or junction')

  const allowedSourceRoots = resolveAllowedRoots(config.allowedSourceRoots, workspaceRoot, 'allowedSourceRoots')
  const allowedDestinationRoots = resolveAllowedRoots(config.allowedDestinationRoots, workspaceRoot, 'allowedDestinationRoots')
  const approval = config.approval ?? DEFAULT_CONFIG.approval
  if (approval !== 'host' && approval !== 'agent') throw new Error("Ditto approval must be 'host' or 'agent'")
  const approvalUnavailable = config.approvalUnavailable ?? DEFAULT_CONFIG.approvalUnavailable
  if (approvalUnavailable !== 'deny' && approvalUnavailable !== 'agent') throw new Error("Ditto approvalUnavailable must be 'deny' or 'agent'")
  const maxItems = config.maxItems ?? DEFAULT_CONFIG.maxItems
  const resultItems = config.resultItems ?? DEFAULT_CONFIG.resultItems
  const evidenceItems = config.evidenceItems ?? DEFAULT_CONFIG.evidenceItems
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 1_000) throw new Error('Ditto maxItems must be an integer from 1 to 1000')
  if (!Number.isInteger(resultItems) || resultItems < 1 || resultItems > 100) throw new Error('Ditto resultItems must be an integer from 1 to 100')
  if (!Number.isInteger(evidenceItems) || evidenceItems < 1 || evidenceItems > 40) throw new Error('Ditto evidenceItems must be an integer from 1 to 40')
  return { workspaceRoot, stateRoot, allowedSourceRoots, allowedDestinationRoots, approval, approvalUnavailable, maxItems, resultItems, evidenceItems }
}

/** True when `target` is `root` or lies below it. Cross-drive paths on Windows are never inside. */
export function insideWorkspace(root: string, target: string): boolean { return within(root, target, true) }
export function insideAnyRoot(roots: readonly string[], target: string): boolean { return roots.some(root => within(root, target, true)) }
export function overlaps(a: string, b: string): boolean { return within(a, b, true) || within(b, a, true) }

function resolveAllowedRoots(inputs: string[] | undefined, workspaceRoot: string, name: string): string[] {
  const values = inputs ?? [workspaceRoot]
  if (!Array.isArray(values) || values.length < 1 || values.length > 32 || values.some(value => typeof value !== 'string' || value.trim() === '')) throw new Error(`Ditto ${name} must contain 1–32 filesystem roots`)
  const roots = values.map(value => canonicalPathSync(isAbsolute(value) ? value : resolve(workspaceRoot, value)))
  return roots.filter((root, index) => roots.findIndex(candidate => sameConfiguredPath(candidate, root)) === index)
}

function sameConfiguredPath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US') : a === b
}
