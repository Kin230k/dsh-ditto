import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'

export const jsonOutput = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

/** Canonicalize every public tool result into the DSH lossless JSON boundary. */
export function json(value: unknown): ReturnType<typeof JSON.parse> { return JSON.parse(JSON.stringify(value)) }

export function checkNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('The Ditto operation was cancelled before it started')
}

/** In-process serialization only. Separate DSH processes must use separate state roots. */
const mutations = new Map<string, Promise<void>>()

export async function withMutation<T>(key: string, work: () => Promise<T>): Promise<T> {
  const prior = mutations.get(key) ?? Promise.resolve()
  let release!: () => void
  const pending = new Promise<void>(resolvePending => { release = resolvePending })
  const tail = prior.then(() => pending)
  mutations.set(key, tail)
  await prior
  try { return await work() } finally { release(); if (mutations.get(key) === tail) mutations.delete(key) }
}

export type ApprovalSource = 'host' | 'agent'

/** The subset of the DSH approval service Ditto relies on. */
export interface ApprovalLike {
  request(request: { agent: NonNullable<ToolRunContext['agent']>; toolName: string; callId?: ToolRunContext['callId']; reason?: string; signal?: AbortSignal }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
}

/**
 * The human gate in front of every write. With `approval: 'host'` and a DSH
 * approval service present, the host asks the user for a one-shot grant tied
 * to this exact tool call; anything but `allowed-once` aborts before any write.
 * Without an approval service (a bare component host, or a deployment that
 * composes none) the tool relies on the skill's rule that the agent has already
 * shown the preview and obtained the user's approval.
 */
export async function requireHumanApproval(options: { ctx: Context; mode: ApprovalSource; exec: Pick<ToolRunContext, 'agent' | 'callId' | 'signal'>; toolName: string; reason: string }): Promise<ApprovalSource> {
  if (options.mode === 'agent') return 'agent'
  const approval = options.ctx.get('approval') as ApprovalLike | undefined
  if (!approval || typeof approval.request !== 'function' || !options.exec.agent) return 'agent'
  const outcome = await approval.request({ agent: options.exec.agent, toolName: options.toolName, callId: options.exec.callId, reason: options.reason, signal: options.exec.signal })
  if (outcome !== 'allowed-once') throw new Error(`The DSH host did not approve ${options.toolName} (${outcome}). Nothing was written. Show the preview to the user and try again only after they approve it; a deployment that never prompts (approval policy "never") cannot run batch writes.`)
  return 'host'
}
