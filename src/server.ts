import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { applyPlan, createPlan, defaultRecipe, listRecipes, loadPlan, loadRecipe, recipeFromPlan, revisePlan, savePlan, saveRecipe } from './core/index.js'
import type { Plan, PlanEdit } from './core/types.js'
import { renderWorkbench } from './ui/workbench.js'

export interface LocalWorkbenchOptions {
  sourceRoot: string
  destinationRoot: string
  stateRoot: string
  plan?: Plan
  recipe?: ReturnType<typeof defaultRecipe>
}

export interface LocalWorkbench {
  url: string
  csrfToken: string
  close(): Promise<void>
}

const MAX_BODY_BYTES = 16 * 1024

/** Starts a single-purpose, loopback-only server. It has no file or shell endpoints. */
export async function startLocalWorkbench(options: LocalWorkbenchOptions): Promise<LocalWorkbench> {
  let plan = options.plan ?? await createPlan({ sourceRoot: options.sourceRoot, destinationRoot: options.destinationRoot, recipe: options.recipe ?? defaultRecipe(), excludedRoots: [options.stateRoot] })
  await savePlan(plan, options.stateRoot)
  const csrfToken = randomBytes(32).toString('base64url')
  let mutationTail = Promise.resolve()
  const server = createServer(async (request, response) => {
    try {
      if (!hasExpectedHost(request, server)) return respondJson(response, 421, { error: '只接受這個本機示範頁面的請求。' })
      const context = { stateRoot: options.stateRoot, csrfToken, getPlan: () => plan, setPlan: (next: Plan) => { plan = next }, sourceRoot: options.sourceRoot, destinationRoot: options.destinationRoot }
      if (request.method === 'POST') await withMutationLock(() => route(request, response, context), tail => { mutationTail = tail }, mutationTail)
      else await route(request, response, context)
    }
    catch (error: unknown) { respondJson(response, statusFor(error), { error: messageFor(error) }) }
  })
  await new Promise<void>((resolveStart, rejectStart) => { server.once('error', rejectStart); server.listen({ host: '127.0.0.1', port: 0 }, () => { server.off('error', rejectStart); resolveStart() }) })
  const address = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${address.port}`, csrfToken, close: () => closeServer(server) }
}

interface RouteContext {
  stateRoot: string
  csrfToken: string
  sourceRoot: string
  destinationRoot: string
  getPlan(): Plan
  setPlan(plan: Plan): void
}

async function route(request: IncomingMessage, response: ServerResponse, context: RouteContext): Promise<void> {
  const method = request.method ?? 'GET'; const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
  if (method === 'GET' && pathname === '/') return respondHtml(response, renderWorkbench(context.getPlan(), { csrfToken: context.csrfToken }))
  if (method === 'GET' && pathname === '/api/plan') return respondJson(response, 200, { plan: context.getPlan() })
  if (method === 'GET' && pathname === '/api/recipe') return respondJson(response, 200, { recipes: await listRecipes(context.stateRoot) })
  if (method !== 'POST' || !['/api/revise', '/api/apply', '/api/recipe', '/api/recipe/load'].includes(pathname)) return respondJson(response, 404, { error: '找不到這個本機功能。' })
  if (!sameOrigin(request) || request.headers['x-dsh-csrf'] !== context.csrfToken) return respondJson(response, 403, { error: '這個本機操作沒有通過安全檢查。' })
  const body = await readJson(request)
  if (pathname === '/api/revise') {
    const revision = integer(body.revision, 'revision'); const edits = planEdits(body.edits)
    if (revision !== context.getPlan().revision) throw new ClientError(409, '檢視已更新，請先重新確認。')
    if (edits.some(edit => context.getPlan().items.find(item => item.id === edit.id)?.status !== 'ready')) throw new ClientError(409, '已有實際結果的檔案不能再修改。')
    const next = revisePlan(context.getPlan(), edits); await savePlan(next, context.stateRoot); context.setPlan(next)
    return respondJson(response, 200, { plan: next })
  }
  if (pathname === '/api/apply') {
    const revision = integer(body.revision, 'revision'); const digest = text(body.digest, 'digest', 64)
    const current = context.getPlan()
    if (revision !== current.revision || digest !== current.digest) throw new ClientError(409, '檢視已更新，請先重新確認。')
    const result = await applyPlan(current, { id: current.id, revision, digest }, context.stateRoot)
    context.setPlan(await loadPlan(current.id, context.stateRoot))
    return respondJson(response, 200, result)
  }
  if (pathname === '/api/recipe') {
    const recipe = recipeFromPlan(context.getPlan(), text(body.name, 'name', 80)); await saveRecipe(recipe, context.stateRoot)
    return respondJson(response, 201, { recipe: { id: recipe.id, name: recipe.name, version: recipe.version, createdAt: recipe.createdAt } })
  }
  const id = text(body.id, 'id', 64); const current = context.getPlan()
  if (!current.items.every(item => item.status === 'ready')) throw new ClientError(409, '已有實際結果，不能取代這份進行中的檢視。')
  const recipe = await loadRecipe(id, context.stateRoot)
  const next = await createPlan({ sourceRoot: context.sourceRoot, destinationRoot: context.destinationRoot, recipe, excludedRoots: [context.stateRoot] })
  await savePlan(next, context.stateRoot); context.setPlan(next)
  return respondJson(response, 200, { plan: next })
}

function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  const host = request.headers.host
  return typeof origin === 'string' && typeof host === 'string' && origin === `http://${host}` && /^127\.0\.0\.1:\d+$/.test(host)
}

function hasExpectedHost(request: IncomingMessage, server: Server): boolean {
  const address = server.address()
  return typeof address === 'object' && address !== null && request.headers.host === `127.0.0.1:${address.port}`
}

async function withMutationLock<T>(work: () => Promise<T>, setTail: (tail: Promise<void>) => void, previous: Promise<void>): Promise<T> {
  let release!: () => void
  const held = new Promise<void>(resolveRelease => { release = resolveRelease })
  const tail = previous.then(() => held)
  setTail(tail)
  await previous
  try { return await work() } finally { release() }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0; const chunks: Buffer[] = []
  for await (const chunk of request) { const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += data.length; if (size > MAX_BODY_BYTES) throw new ClientError(413, '請求內容太大。'); chunks.push(data) }
  try { const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error(); return parsed as Record<string, unknown> } catch { throw new ClientError(400, '請求格式不正確。') }
}
function planEdits(value: unknown): PlanEdit[] { if (!Array.isArray(value) || value.length > 1_000 || value.some(edit => !edit || typeof edit !== 'object' || typeof (edit as PlanEdit).id !== 'string' || typeof (edit as PlanEdit).destination !== 'string')) throw new ClientError(400, '修改內容不正確。'); return value as PlanEdit[] }
function integer(value: unknown, name: string): number { if (!Number.isInteger(value)) throw new ClientError(400, `${name} 不正確。`); return value as number }
function text(value: unknown, name: string, maximum: number): string { if (typeof value !== 'string' || value.length === 0 || value.length > maximum) throw new ClientError(400, `${name} 不正確。`); return value }
function respondJson(response: ServerResponse, status: number, value: unknown): void { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(value)) }
function respondHtml(response: ServerResponse, value: string): void { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }); response.end(value) }
function messageFor(error: unknown): string { return error instanceof ClientError ? error.message : error instanceof Error ? error.message.slice(0, 300) : '本機操作沒有完成。' }
function statusFor(error: unknown): number { return error instanceof ClientError ? error.status : 500 }
class ClientError extends Error { constructor(readonly status: number, message: string) { super(message) } }
function closeServer(server: Server): Promise<void> { return new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose())) }
