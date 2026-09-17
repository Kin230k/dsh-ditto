import { resolve } from 'node:path'
import { canonicalPathSync, within } from '../core/paths.js'

/**
 * Configuration that the profile owner, rather than the model, supplies.
 * All model-facing folders must remain under `workspaceRoot`.
 */
export interface DshDittoConfig {
  /** Location for durable plans, batches, and saved recipes; relative values are anchored to workspaceRoot. It must stay inside workspaceRoot. Default: `.dsh-ditto`. */
  stateRoot?: string
  /** The one directory tree in which this plugin may read sources and write outputs. Default: the DSH process working directory. */
  workspaceRoot?: string
  /**
   * How the apply tools obtain human approval.
   * `host` (default): ask the DSH approval service (`ctx.approval`) for a one-shot grant before writing; when the host
   * composes no approval service, fall back to `agent`. `agent`: rely on the agent having asked the user, as the skill requires.
   */
  approval?: 'host' | 'agent'
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
  approval: 'host' | 'agent'
  maxItems: number
  resultItems: number
  evidenceItems: number
}

export const DEFAULT_CONFIG = { stateRoot: '.dsh-ditto', approval: 'host', maxItems: 200, resultItems: 25, evidenceItems: 20 } as const

export function resolveConfig(config: DshDittoConfig): ResolvedConfig {
  // Canonical (native realpath, Windows short names expanded) so every later boundary comparison is apples to apples.
  const workspaceRoot = canonicalPathSync(config.workspaceRoot ?? process.cwd())
  // A relative stateRoot is anchored to the workspace, not to the process working directory.
  const stateRoot = canonicalPathSync(resolve(workspaceRoot, config.stateRoot ?? DEFAULT_CONFIG.stateRoot))
  if (!within(workspaceRoot, stateRoot, true)) throw new Error('Ditto stateRoot must stay inside workspaceRoot')
  const approval = config.approval ?? DEFAULT_CONFIG.approval
  if (approval !== 'host' && approval !== 'agent') throw new Error("Ditto approval must be 'host' or 'agent'")
  const maxItems = config.maxItems ?? DEFAULT_CONFIG.maxItems
  const resultItems = config.resultItems ?? DEFAULT_CONFIG.resultItems
  const evidenceItems = config.evidenceItems ?? DEFAULT_CONFIG.evidenceItems
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 1_000) throw new Error('Ditto maxItems must be an integer from 1 to 1000')
  if (!Number.isInteger(resultItems) || resultItems < 1 || resultItems > 100) throw new Error('Ditto resultItems must be an integer from 1 to 100')
  if (!Number.isInteger(evidenceItems) || evidenceItems < 1 || evidenceItems > 40) throw new Error('Ditto evidenceItems must be an integer from 1 to 40')
  return { workspaceRoot, stateRoot, approval, maxItems, resultItems, evidenceItems }
}

/** True when `target` is `root` or lies below it. Cross-drive paths on Windows are never inside. */
export function insideWorkspace(root: string, target: string): boolean { return within(root, target, true) }

export function overlaps(a: string, b: string): boolean { return within(a, b, true) || within(b, a, true) }
