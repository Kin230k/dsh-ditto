import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { applySpecBatch, approveSpecSamples, countConfirmations, createSpecBatch, generateSpecBatch, saveSpecBatch } from './core/index.js'
import type { CitedText, PublicApiFact, SpecBatch, SpecGenerator } from './spec/types.js'

/**
 * A synthetic repository of 16 small TypeScript modules plus three files the
 * scanner must exclude. Everything is invented; nothing is executed.
 */
export const DEMO_MODULES: ReadonlyArray<readonly [path: string, source: string]> = [
  ['src/index.ts', `import { registerUserRoutes } from './routes/users.js'\nimport { registerOrderRoutes } from './routes/orders.js'\nimport { registerWebhookRoutes } from './routes/webhooks.js'\nimport { loadEnv } from './config/env.js'\n\nexport function createApp() {\n  const env = loadEnv()\n  const routes = [registerUserRoutes, registerOrderRoutes, registerWebhookRoutes]\n  return { env, routes }\n}\n`],
  ['src/config/env.ts', `export interface Env { port: number; databaseUrl: string; webhookSecret?: string }\n\nexport function loadEnv(): Env {\n  const port = Number(process.env.PORT ?? 3000)\n  const databaseUrl = process.env.DATABASE_URL ?? 'postgres://localhost/app'\n  return { port, databaseUrl, webhookSecret: process.env.WEBHOOK_SECRET }\n}\n`],
  ['src/routes/users.ts', `import { UserService } from '../services/users.js'\nimport { requireAuth } from '../middleware/auth.js'\n\nexport function registerUserRoutes(router: { get(path: string, ...handlers: unknown[]): void }) {\n  const users = new UserService()\n  router.get('/users/:id', requireAuth, (request: { params: { id: string } }) => users.find(request.params.id))\n  router.get('/users', requireAuth, () => users.list())\n}\n`],
  ['src/routes/orders.ts', `import { OrderService } from '../services/orders.js'\nimport { requireAuth } from '../middleware/auth.js'\n\nexport function registerOrderRoutes(router: { post(path: string, ...handlers: unknown[]): void }) {\n  const orders = new OrderService()\n  router.post('/orders', requireAuth, (request: { body: { userId: string; items: string[] } }) => orders.create(request.body.userId, request.body.items))\n}\n`],
  ['src/routes/webhooks.ts', `import { verifySignature } from '../utils/validate.js'\n\n// Event names are resolved from configuration at runtime, so the accepted set is not visible here.\nexport function registerWebhookRoutes(router: { post(path: string, handler: unknown): void }, handlers: Record<string, (payload: unknown) => Promise<void>>) {\n  router.post('/webhooks/:event', async (request: { params: { event: string }; headers: Record<string, string>; body: unknown }) => {\n    if (!verifySignature(request.headers['x-signature'] ?? '', JSON.stringify(request.body))) throw new Error('invalid signature')\n    const handler = handlers[request.params.event]\n    if (!handler) return { status: 202, ignored: true }\n    await handler(request.body)\n    return { status: 204 }\n  })\n}\n`],
  ['src/services/users.ts', `import type { User } from '../models/user.js'\nimport { formatName } from '../utils/format.js'\n\nexport class UserService {\n  private readonly users = new Map<string, User>()\n  find(id: string): User | undefined { return this.users.get(id) }\n  list(): User[] { return [...this.users.values()].sort((a, b) => formatName(a).localeCompare(formatName(b))) }\n  save(user: User): void { this.users.set(user.id, user) }\n}\n`],
  ['src/services/orders.ts', `import type { Order } from '../models/order.js'\nimport { BillingService } from './billing.js'\nimport { NotificationService } from './notifications.js'\n\nexport class OrderService {\n  private readonly billing = new BillingService()\n  private readonly notifications = new NotificationService()\n  async create(userId: string, items: string[]): Promise<Order> {\n    if (items.length === 0) throw new Error('an order needs at least one item')\n    const order: Order = { id: crypto.randomUUID(), userId, items, status: 'pending' }\n    await this.billing.charge(order)\n    await this.notifications.send(userId, 'order-created')\n    return order\n  }\n}\n`],
  ['src/services/billing.ts', `import type { Invoice } from '../models/invoice.js'\nimport type { Order } from '../models/order.js'\nimport { withRetry } from '../utils/retry.js'\n\nexport class BillingService {\n  async charge(order: Order): Promise<Invoice> {\n    return withRetry(async () => ({ id: \`inv_\${order.id}\`, orderId: order.id, amountCents: order.items.length * 1200, paid: true }), 3)\n  }\n}\n`],
  ['src/services/notifications.ts', `export type Channel = 'email' | 'sms'\n\nexport class NotificationService {\n  private readonly sent: Array<{ userId: string; template: string; channel: Channel }> = []\n  async send(userId: string, template: string, channel: Channel = 'email'): Promise<void> {\n    this.sent.push({ userId, template, channel })\n  }\n  history(userId: string) { return this.sent.filter(entry => entry.userId === userId) }\n}\n`],
  ['src/models/user.ts', `export interface User {\n  id: string\n  firstName: string\n  lastName: string\n  email: string\n  createdAt: string\n}\n`],
  ['src/models/order.ts', `export type OrderStatus = 'pending' | 'paid' | 'shipped' | 'cancelled'\n\nexport interface Order {\n  id: string\n  userId: string\n  items: string[]\n  status: OrderStatus\n}\n`],
  ['src/models/invoice.ts', `export interface Invoice {\n  id: string\n  orderId: string\n  amountCents: number\n  paid: boolean\n}\n`],
  ['src/utils/validate.ts', `import { createHmac, timingSafeEqual } from 'node:crypto'\n\nexport function isEmail(value: string): boolean { return /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(value) }\n\nexport function verifySignature(signature: string, payload: string, secret = process.env.WEBHOOK_SECRET ?? ''): boolean {\n  const expected = createHmac('sha256', secret).update(payload).digest('hex')\n  return signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected))\n}\n`],
  ['src/utils/format.ts', `import type { User } from '../models/user.js'\n\nexport function formatName(user: Pick<User, 'firstName' | 'lastName'>): string { return \`\${user.lastName}, \${user.firstName}\` }\n\nexport function formatCents(cents: number, currency = 'USD'): string { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100) }\n`],
  ['src/utils/retry.ts', `export async function withRetry<T>(work: () => Promise<T>, attempts: number, delayMs = 50): Promise<T> {\n  let lastError: unknown\n  for (let attempt = 1; attempt <= attempts; attempt++) {\n    try { return await work() } catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, delayMs * attempt)) }\n  }\n  throw lastError instanceof Error ? lastError : new Error('retry failed')\n}\n`],
  ['src/middleware/auth.ts', `export interface AuthenticatedRequest { headers: Record<string, string | undefined>; user?: { id: string } }\n\nexport function requireAuth(request: AuthenticatedRequest, next: () => void): void {\n  const token = request.headers.authorization\n  if (!token || !token.startsWith('Bearer ')) throw new Error('unauthorized')\n  request.user = { id: token.slice('Bearer '.length) }\n  next()\n}\n`],
]

const EXCLUDED_FIXTURES: ReadonlyArray<readonly [path: string, source: string]> = [
  ['README.md', '# Demo repository\n\nSynthetic fixture created by `dsh-ditto demo`. Safe to delete.\n'],
  ['src/types.d.ts', 'declare module "demo" {}\n'],
  ['node_modules/left-pad/index.js', 'module.exports = value => value\n'],
]

/** Modules whose behaviour is configuration-driven get an open question in the demo, to show the "Needs confirmation" path. */
const QUESTIONS: Readonly<Record<string, string>> = {
  'src/routes/webhooks.ts': 'Which event names does the webhook dispatcher accept at runtime, given that the handler map is supplied by configuration rather than this module?',
}

export async function writeDemoRepository(sourceRoot: string): Promise<void> {
  for (const [relativePath, source] of [...DEMO_MODULES, ...EXCLUDED_FIXTURES]) {
    const file = join(sourceRoot, ...relativePath.split('/'))
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, source, 'utf8')
  }
}

/**
 * A deterministic generator for demos and tests. It derives every statement
 * from the structural facts and cites the evidence chunk that contains the
 * named export, so the output is honest about its provenance — and it is
 * clearly labelled as not a model.
 */
export const demoGenerator: SpecGenerator = {
  id: 'ditto-demo-generator',
  async generate({ module, approvedSamples }) {
    const cite = (name?: string): string[] => [((name ? module.evidence.find(chunk => chunk.text.includes(name)) : undefined) ?? module.evidence[0]!).id]
    const source = module.evidence.map(chunk => chunk.text).join('\n')
    const publicApi: PublicApiFact[] = module.facts.exports.map(name => ({ kind: kindOf(source, name), name, text: `Exported from \`${module.relativePath}\`.`, citations: cite(name), ...(parametersOf(source, name) ? { parameters: parametersOf(source, name) } : {}) }))
    const dependencies: CitedText[] = module.facts.imports.map(specifier => ({ text: `Imports \`${specifier}\`.`, citations: cite(specifier) }))
    const errors: CitedText[] = [...source.matchAll(/throw new Error\('([^']+)'\)/g)].map(match => ({ text: `Throws \`${match[1]}\`.`, citations: cite(match[1]) }))
    const question = QUESTIONS[module.relativePath]
    return {
      metadata: { generator: 'ditto-demo-generator', synthetic: 'true', calibratedWith: String(approvedSamples.length) },
      draft: {
        version: 1,
        moduleId: module.id,
        title: { text: module.relativePath, citations: cite() },
        purpose: { text: module.facts.exports.length ? `Provides ${module.facts.exports.map(name => `\`${name}\``).join(', ')}.` : 'Provides no exports; this module runs for its side effects.', citations: cite(module.facts.exports[0]) },
        ...(publicApi.length ? { publicApi } : {}),
        ...(dependencies.length ? { dependencies } : {}),
        ...(errors.length ? { errors } : {}),
        ...(question ? { confirmations: [{ question, relatedEvidenceIds: cite('handlers') }] } : {}),
      },
    }
  },
}

function kindOf(source: string, name: string): PublicApiFact['kind'] {
  if (new RegExp(`\\b(?:function\\*?|async function)\\s+${name}\\b`).test(source)) return 'function'
  if (new RegExp(`\\bclass\\s+${name}\\b`).test(source)) return 'class'
  if (new RegExp(`\\b(?:interface|type)\\s+${name}\\b`).test(source)) return 'type'
  return 'value'
}

function parametersOf(source: string, name: string): string[] | undefined {
  const match = new RegExp(`function\\s+${name}\\s*(?:<[^>]*>)?\\(`).exec(source)
  if (!match) return undefined
  // Walk to the matching close paren so nested object/generic types do not split the list.
  let depth = 1; let current = ''; const parts: string[] = []
  for (let index = match.index + match[0].length; index < source.length && depth > 0; index++) {
    const char = source[index]!
    if ('([{<'.includes(char)) depth++
    else if (')]}>'.includes(char) && !(char === '>' && source[index - 1] === '=')) { depth--; if (depth === 0) break }
    if (char === ',' && depth === 1) { parts.push(current); current = '' } else current += char
  }
  parts.push(current)
  const names = parts.map(part => /^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)/.exec(part)?.[1]).filter((value): value is string => Boolean(value))
  return names.length ? names.slice(0, 8) : undefined
}

export interface HeadlessDemoResult {
  runRoot: string
  sourceRoot: string
  outputRoot: string
  batch: SpecBatch
  written: number
  needsConfirmation: string[]
  sourceHashesUnchanged: boolean
}

/**
 * Runs the whole workflow without a browser: discover → samples → (auto-accept
 * the rendered samples) → approve → full preview → apply → verify. It is the
 * demo you can record in a terminal and the demo CI exercises.
 */
export async function runHeadlessDemo(runRoot: string, log: (line: string) => void = () => undefined): Promise<HeadlessDemoResult> {
  const sourceRoot = join(runRoot, 'source'); const outputRoot = join(runRoot, 'specifications'); const stateRoot = join(runRoot, 'state')
  await writeDemoRepository(sourceRoot)
  const hashesBefore = await hashTree(sourceRoot)
  log('Ditto demo — synthetic repository, deterministic generator, no model calls, no API key')
  log(`Source  ${sourceRoot}`)
  log(`Output  ${outputRoot}`)
  log('')
  let batch = await createSpecBatch({ sourceRoot, outputRoot, stateRoot })
  const excluded = batch.discovery.excluded.map(item => `${item.relativePath} (${item.reason})`).join(', ')
  log(`1. Discover   ${batch.discovery.inScope} modules in scope · ${batch.discovery.excludedTotal} excluded: ${excluded}`)
  batch = await generateSpecBatch(batch, demoGenerator, { only: 'samples', stateRoot })
  const sampleNames = batch.samples.map(id => batch.items.find(item => item.id === id)!.relativePath)
  log(`2. Samples    3 representative modules: ${sampleNames.join(', ')}`)
  log('3. Review     the headless demo accepts the three rendered samples unchanged (edit them in the browser demo)')
  batch = approveSpecSamples(batch)
  log(`4. Approve    recipe revision ${batch.revision} · digest ${batch.digest.slice(0, 12)}…`)
  batch = await generateSpecBatch(batch, demoGenerator, { only: 'remaining', stateRoot })
  const needsConfirmation = batch.items.filter(item => countConfirmations(item.renderedMarkdown) > 0).map(item => item.relativePath)
  const rendered = batch.items.filter(item => item.renderedMarkdown).length
  log(`5. Preview    ${rendered}/${batch.items.length} specifications rendered · ${needsConfirmation.length} need confirmation${needsConfirmation.length ? `: ${needsConfirmation.join(', ')}` : ''}`)
  await saveSpecBatch(batch, stateRoot)
  const result = await applySpecBatch(batch, { id: batch.id, revision: batch.revision, digest: batch.digest }, stateRoot)
  const hashesAfter = await hashTree(sourceRoot)
  const sourceHashesUnchanged = hashesBefore === hashesAfter
  log(`6. Apply      ${result.summary.applied}/${result.summary.total} written · ${result.summary.failed + result.summary.rejected} failed · ${sourceHashesUnchanged ? '0 source files modified (hashes re-verified)' : 'SOURCE CHANGED — this must never happen'}`)
  log('')
  log(`Specifications: ${outputRoot}`)
  return { runRoot, sourceRoot, outputRoot, batch: { ...batch, items: result.items, summary: result.summary }, written: result.summary.applied, needsConfirmation, sourceHashesUnchanged }
}

async function hashTree(sourceRoot: string): Promise<string> {
  const hash = createHash('sha256')
  for (const [relativePath] of [...DEMO_MODULES, ...EXCLUDED_FIXTURES]) hash.update(relativePath).update(await readFile(join(sourceRoot, ...relativePath.split('/'))))
  return hash.digest('hex')
}
