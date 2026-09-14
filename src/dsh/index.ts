import { realpath } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  applyPlan,
  createPlan,
  defaultRecipe,
  listRecipes,
  loadPlan,
  loadRecipe,
  recipeFromPlan,
  revisePlan,
  savePlan,
  saveRecipe,
  type Plan,
} from '../core/index.js'

/**
 * Configuration that the profile owner, rather than the model, supplies.
 * All model-facing folders must remain under `workspaceRoot`.
 */
export interface DshDittoConfig {
  /** Location for durable plans and saved recipes. It must stay in workspaceRoot. */
  stateRoot?: string
  /** The one directory tree in which this plugin may read sources and write copies. */
  workspaceRoot?: string
  /** Maximum source files a model may ask one preview to enumerate (1–1,000). */
  maxItems?: number
  /** Maximum item records returned by one native tool response (1–100). */
  resultItems?: number
}

interface ResolvedConfig {
  stateRoot: string
  workspaceRoot: string
  maxItems: number
  resultItems: number
}

interface PlanView {
  plan: {
    id: string
    revision: number
    digest: string
    sourceRoot: string
    destinationRoot: string
    summary: Plan['summary']
    recipe: Pick<Plan['recipe'], 'id' | 'name' | 'version' | 'pattern' | 'classification'>
  }
  items: Array<Pick<Plan['items'][number], 'id' | 'relativePath' | 'destination' | 'classification' | 'status' | 'reason'>>
  page: { offset: number; returned: number; total: number; nextOffset?: number }
}

/** In-process serialization only. Separate DSH processes must use separate state roots. */
const planMutations = new Map<string, Promise<void>>()

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshDitto: DshDitto
  }
}

/** Native DSH tools for the reviewed-copy M0 workflow. */
export class DshDitto extends Service<DshDittoConfig> {
  static inject = ['tools']
  static provide = 'dshDitto'

  readonly config: ResolvedConfig

  constructor(ctx: Context, config: DshDittoConfig = {}) {
    super(ctx, 'dshDitto')
    this.config = resolveConfig(config)
    // ToolRuntime registers into the current Cordis fiber, so these effects are
    // removed automatically if this bundle is unloaded or its patch reloads.
    ctx.tools.register(previewTool(this))
    ctx.tools.register(reviseTool(this))
    ctx.tools.register(applyTool(this))
    ctx.tools.register(statusTool(this))
    ctx.tools.register(recipeTool(this))
  }

  async preview(input: { sourceRoot: string; destinationRoot: string; recipeName?: string; pattern?: string; classification?: 'folder-prefix' | 'none'; maxItems?: number }): Promise<Plan> {
    const roots = await this.checkedRoots(input.sourceRoot, input.destinationRoot)
    const requested = input.maxItems ?? this.config.maxItems
    if (!Number.isInteger(requested) || requested < 1 || requested > this.config.maxItems) throw new Error(`max_items must be an integer from 1 to ${this.config.maxItems}`)
    const recipe = defaultRecipe(input.recipeName ?? '我的整理方式')
    if (input.pattern !== undefined) recipe.pattern = input.pattern
    if (input.classification !== undefined) recipe.classification = { kind: input.classification }
    const plan = await createPlan({ sourceRoot: roots.sourceRoot, destinationRoot: roots.destinationRoot, recipe, maxFiles: requested, excludedRoots: [this.config.stateRoot] })
    await savePlan(plan, this.config.stateRoot)
    return plan
  }

  async revise(planId: string, revision: number, edits: Array<{ id: string; destination: string }>): Promise<Plan> {
    return withPlanMutation(planId, async () => {
      const plan = await loadPlan(planId, this.config.stateRoot)
      await this.checkedPersistedPlanRoots(plan)
      if (!Number.isInteger(revision) || revision !== plan.revision) throw new Error('Plan changed after review; request its current status before revising')
      const next = revisePlan(plan, edits)
      await savePlan(next, this.config.stateRoot)
      return next
    })
  }

  async apply(planId: string, revision: number, digest: string): Promise<Awaited<ReturnType<typeof applyPlan>>> {
    return withPlanMutation(planId, async () => {
      const plan = await loadPlan(planId, this.config.stateRoot)
      await this.checkedPersistedPlanRoots(plan)
      return applyPlan(plan, { id: planId, revision, digest }, this.config.stateRoot)
    })
  }

  async status(planId: string): Promise<Plan> {
    const plan = await loadPlan(planId, this.config.stateRoot)
    await this.checkedPersistedPlanRoots(plan)
    return plan
  }

  async saveRecipe(planId: string, name: string) {
    return withPlanMutation(planId, async () => {
      const plan = await this.status(planId)
      const recipe = recipeFromPlan(plan, name)
      await saveRecipe(recipe, this.config.stateRoot)
      return recipe
    })
  }

  async getRecipe(recipeId: string) { return loadRecipe(recipeId, this.config.stateRoot) }
  async recipes() { return listRecipes(this.config.stateRoot) }

  view(plan: Plan, offset = 0, limit = this.config.resultItems): PlanView {
    if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer')
    if (!Number.isInteger(limit) || limit < 1 || limit > this.config.resultItems) throw new Error(`limit must be an integer from 1 to ${this.config.resultItems}`)
    const items = plan.items.slice(offset, offset + limit).map(item => ({
      id: item.id,
      relativePath: item.relativePath,
      destination: item.destination,
      classification: item.classification,
      status: item.status,
      ...(item.reason === undefined ? {} : { reason: item.reason }),
    }))
    return {
      plan: {
        id: plan.id,
        revision: plan.revision,
        digest: plan.digest,
        sourceRoot: plan.sourceRoot,
        destinationRoot: plan.destinationRoot,
        summary: plan.summary,
        recipe: { id: plan.recipe.id, name: plan.recipe.name, version: plan.recipe.version, pattern: plan.recipe.pattern, classification: plan.recipe.classification },
      },
      items,
      page: { offset, returned: items.length, total: plan.items.length, ...(offset + items.length < plan.items.length ? { nextOffset: offset + items.length } : {}) },
    }
  }

  private async checkedRoots(sourceInput: string, destinationInput: string): Promise<{ sourceRoot: string; destinationRoot: string }> {
    if (typeof sourceInput !== 'string' || typeof destinationInput !== 'string') throw new Error('Source and destination folders are required')
    const sourceRoot = await realpath(resolve(sourceInput))
    const destinationRoot = resolve(destinationInput)
    if (!within(this.config.workspaceRoot, sourceRoot) || !within(this.config.workspaceRoot, destinationRoot)) throw new Error('Folders must stay inside this DSH Ditto profile workspace')
    if (overlaps(destinationRoot, this.config.stateRoot)) throw new Error('The output folder must not include DSH Ditto state metadata; choose a separate output folder')
    return { sourceRoot, destinationRoot }
  }

  private async checkedPersistedPlanRoots(plan: Plan): Promise<void> {
    const sourceRoot = await realpath(plan.sourceRoot)
    if (sourceRoot !== plan.sourceRoot || !within(this.config.workspaceRoot, sourceRoot) || !within(this.config.workspaceRoot, resolve(plan.destinationRoot))) throw new Error('Saved plan roots are outside this DSH Ditto profile workspace')
  }

}

function previewTool(service: DshDitto) {
  return defineTool({
    name: 'ditto_preview',
    description: 'Create a read-only DSH Ditto preview for a batch of files inside the configured workspace. This writes only durable local review metadata, never source files or output copies. Returns the reviewed plan identity, digest, summary, and the first bounded page of proposed names; use ditto_status for later pages. Review proposed names with the user before ditto_apply.',
    parameters: {
      source_root: { type: 'string', required: true, description: 'Existing source folder inside the configured Ditto workspace. It is read-only.' },
      destination_root: { type: 'string', required: true, description: 'New output folder inside the configured Ditto workspace. It must be outside source_root and never overlaps Ditto state metadata.' },
      recipe_name: { type: 'string', description: 'Optional 1–80 character label for this draft rule.' },
      pattern: { type: 'string', description: 'Optional declarative filename pattern. Only {stem}, {ext}, {index}, and {class} are substituted; for example "整理-{stem}" or "{index}-{class}-{stem}". It cannot contain paths, scripts, or shell commands.' },
      classification: { type: 'string', enum: ['folder-prefix', 'none'], description: 'Whether copies are grouped under a deterministic classification folder.' },
      max_items: { type: 'integer', description: 'Optional cap, from 1 to the profile maximum.' },
    },
    output: jsonOutput,
    async execute(args, exec) {
      checkNotAborted(exec.signal)
      const plan = await service.preview({ sourceRoot: args.source_root, destinationRoot: args.destination_root, recipeName: args.recipe_name, pattern: args.pattern, classification: args.classification, maxItems: args.max_items })
      checkNotAborted(exec.signal)
      return json(service.view(plan, 0))
    },
  })
}

function reviseTool(service: DshDitto) {
  return defineTool({
    name: 'ditto_revise',
    description: 'Revise reviewed DSH Ditto output-relative destination names. This never copies files. Returns a new revision and digest plus the first page; if the revision is stale, call ditto_status and re-review before retrying. If destinations collide, choose unique names and call ditto_revise again.',
    parameters: {
      plan_id: { type: 'string', required: true, description: 'Plan id returned by ditto_preview or ditto_status.' },
      revision: { type: 'integer', required: true, description: 'Exact current plan revision returned by ditto_preview, ditto_revise, or ditto_status.' },
      edits: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true, description: 'Item id from the plan page.' }, destination: { type: 'string', required: true, description: 'Unique output-root-relative destination retaining the source extension.' } } } },
    },
    output: jsonOutput,
    async execute(args, exec) {
      checkNotAborted(exec.signal)
      const plan = await service.revise(args.plan_id, args.revision, args.edits)
      return json(service.view(plan, 0))
    },
  })
}

function applyTool(service: DshDitto) {
  return defineTool({
    name: 'ditto_apply',
    description: 'Create copies using exactly one reviewed DSH Ditto plan. Require the user to approve the displayed batch before calling this. The digest proves plan identity and freshness; it is not human-approval proof. Originals remain untouched and completed output copies are never overwritten. Returns actual statuses and only the first bounded item page; use ditto_status with nextOffset for the rest. A stale revision or digest requires ditto_status and renewed review; a changed source requires a new ditto_preview.',
    parameters: {
      plan_id: { type: 'string', required: true, description: 'Plan id returned by ditto_preview or ditto_status.' },
      revision: { type: 'integer', required: true, description: 'Exact current revision. If rejected as stale, call ditto_status before any retry.' },
      digest: { type: 'string', required: true, description: 'Exact review digest returned by ditto_preview, ditto_revise, or ditto_status.' },
    },
    output: jsonOutput,
    async execute(args, exec) {
      checkNotAborted(exec.signal)
      const result = await service.apply(args.plan_id, args.revision, args.digest)
      checkNotAborted(exec.signal)
      const plan = await service.status(args.plan_id)
      return json({ result: { planId: result.planId, revision: result.revision, digest: result.digest, summary: result.summary }, ...service.view(plan, 0) })
    },
  })
}

function statusTool(service: DshDitto) {
  return defineTool({
    name: 'ditto_status',
    description: 'Read the current durable DSH Ditto plan and actual per-item statuses without changing files. Returns a bounded page and nextOffset when more items remain. Use it to recover the current revision/digest after a stale mutation error.',
    parameters: {
      plan_id: { type: 'string', required: true, description: 'Plan id returned by ditto_preview.' },
      offset: { type: 'integer', description: 'Zero-based item offset; default 0. Pass prior nextOffset to continue a page.' },
      limit: { type: 'integer', description: 'Item count; default and maximum come from profile configuration.' },
    },
    output: jsonOutput,
    async execute(args, exec) {
      checkNotAborted(exec.signal)
      return json(service.view(await service.status(args.plan_id), args.offset ?? 0, args.limit ?? service.config.resultItems))
    },
  })
}

function recipeTool(service: DshDitto) {
  return defineTool({
    name: 'ditto_recipe',
    description: 'Save a reviewed DSH Ditto plan as a versioned declarative recipe, list saved recipe summaries, or read one saved recipe. Recipes contain no shell commands, scripts, or executable code. action=save requires plan_id and name and returns the saved recipe; action=list returns summaries; action=get requires recipe_id and returns that recipe.',
    parameters: {
      action: { type: 'string', required: true, enum: ['save', 'list', 'get'] },
      plan_id: { type: 'string', description: 'Required for action save: id from ditto_preview or ditto_status.' },
      name: { type: 'string', description: 'Required for action save: recipe name from 1 to 80 characters.' },
      recipe_id: { type: 'string', description: 'Required for action get: id returned by action=list or action=save.' },
    },
    output: jsonOutput,
    async execute(args, exec) {
      checkNotAborted(exec.signal)
      if (args.action === 'list') return json({ recipes: await service.recipes() })
      if (args.action === 'get') {
        if (args.recipe_id === undefined) throw new Error('recipe_id is required when action is get')
        return json({ recipe: await service.getRecipe(args.recipe_id) })
      }
      if (args.plan_id === undefined || args.name === undefined) throw new Error('plan_id and name are required when action is save')
      return json({ recipe: await service.saveRecipe(args.plan_id, args.name) })
    },
  })
}

const jsonOutput = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

/** Canonicalize every public tool result into the DSH lossless JSON boundary. */
function json(value: unknown): ReturnType<typeof JSON.parse> { return JSON.parse(JSON.stringify(value)) }

function resolveConfig(config: DshDittoConfig): ResolvedConfig {
  const workspaceRoot = resolve(config.workspaceRoot ?? process.cwd())
  const stateRoot = resolve(config.stateRoot ?? '.dsh-ditto')
  if (!within(workspaceRoot, stateRoot)) throw new Error('DSH Ditto stateRoot must stay inside workspaceRoot')
  const maxItems = config.maxItems ?? 200
  const resultItems = config.resultItems ?? 25
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 1_000) throw new Error('DSH Ditto maxItems must be an integer from 1 to 1000')
  if (!Number.isInteger(resultItems) || resultItems < 1 || resultItems > 100) throw new Error('DSH Ditto resultItems must be an integer from 1 to 100')
  return { workspaceRoot, stateRoot, maxItems, resultItems }
}

function within(root: string, target: string): boolean {
  const path = relative(resolve(root), resolve(target))
  return path === '' || (path !== '..' && !path.startsWith('..\\') && !path.startsWith('../'))
}

function overlaps(a: string, b: string): boolean { return within(a, b) || within(b, a) }

async function withPlanMutation<T>(planId: string, work: () => Promise<T>): Promise<T> {
  const prior = planMutations.get(planId) ?? Promise.resolve()
  let release!: () => void
  const pending = new Promise<void>(resolvePending => { release = resolvePending })
  const tail = prior.then(() => pending)
  planMutations.set(planId, tail)
  await prior
  try { return await work() } finally { release(); if (planMutations.get(planId) === tail) planMutations.delete(planId) }
}

function checkNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('DSH Ditto operation was cancelled before it started')
}

export default DshDitto
