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
  applySpecBatch,
  approveSpecSamples,
  createSpecBatch,
  loadSpecBatch,
  reviseSpecBatch,
  saveSpecBatch,
  submitSpecDraft,
  type SpecBatch,
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
  /** Maximum source-evidence chunks returned by one spec-module request (1–40). */
  evidenceItems?: number
}

interface ResolvedConfig {
  stateRoot: string
  workspaceRoot: string
  maxItems: number
  resultItems: number
  evidenceItems: number
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

interface SpecBatchView {
  batch: {
    id: string
    revision: number
    digest: string
    sourceRoot: string
    outputRoot: string
    samples: string[]
    summary: SpecBatch['summary']
    instructions: string
    approvalRevision?: number
    approvedSampleCount: number
    /** Present when the M1 core records discovery exclusions. */
    discovery?: unknown
  }
  items: Array<{
    id: string
    relativePath: string
    outputPath: string
    status: string
    reason?: string
    evidenceCount: number
    hasDraft: boolean
  }>
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
    ctx.tools.register(specCreateTool(this))
    ctx.tools.register(specQueueTool(this))
    ctx.tools.register(specModuleTool(this))
    ctx.tools.register(specSubmitTool(this))
    ctx.tools.register(specReviewTool(this))
    ctx.tools.register(specReviseTool(this))
    ctx.tools.register(specApproveTool(this))
    ctx.tools.register(specApplyTool(this))
    ctx.tools.register(specStatusTool(this))
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

  /**
   * M1 deliberately does not call ctx.llm. A DSH host may expose different
   * provider routes and user approvals, so the agent obtains this bounded
   * evidence context, generates a JSON draft, then submits it for validation.
   */
  async createSpec(input: { sourceRoot: string; outputRoot: string; instructions?: string }): Promise<SpecBatch> {
    const roots = await this.checkedRoots(input.sourceRoot, input.outputRoot)
    const batch = await createSpecBatch({ sourceRoot: roots.sourceRoot, outputRoot: roots.destinationRoot, stateRoot: this.config.stateRoot, instructions: input.instructions })
    await saveSpecBatch(batch, this.config.stateRoot)
    return batch
  }

  async specStatus(batchId: string): Promise<SpecBatch> {
    const batch = await loadSpecBatch(batchId, this.config.stateRoot)
    await this.checkedPersistedSpecRoots(batch)
    return batch
  }

  async submitSpec(batchId: string, revision: number, digest: string, moduleId: string, draft: unknown, metadata?: Record<string, string>): Promise<SpecBatch> {
    return withPlanMutation(`spec:${batchId}`, async () => {
      const batch = await this.specStatus(batchId)
      assertSpecIdentity(batch, revision, digest)
      const next = submitSpecDraft(batch, { moduleId, draft, metadata, generatorId: 'dsh-agent-driven' })
      await saveSpecBatch(next, this.config.stateRoot)
      return next
    })
  }

  async approveSpec(batchId: string, revision: number, digest: string): Promise<SpecBatch> {
    return withPlanMutation(`spec:${batchId}`, async () => {
      const batch = await this.specStatus(batchId)
      assertSpecIdentity(batch, revision, digest)
      const next = approveSpecSamples(batch)
      await saveSpecBatch(next, this.config.stateRoot)
      return next
    })
  }

  async reviseSpec(batchId: string, revision: number, digest: string, input: { sampleEdits?: Array<{ moduleId: string; markdown: string }>; instructions?: string }): Promise<SpecBatch> {
    return withPlanMutation(`spec:${batchId}`, async () => {
      const batch = await this.specStatus(batchId)
      assertSpecIdentity(batch, revision, digest)
      const next = reviseSpecBatch(batch, input)
      await saveSpecBatch(next, this.config.stateRoot)
      return next
    })
  }

  async applySpec(batchId: string, revision: number, digest: string) {
    return withPlanMutation(`spec:${batchId}`, async () => {
      const batch = await this.specStatus(batchId)
      assertSpecIdentity(batch, revision, digest)
      return applySpecBatch(batch, { id: batchId, revision, digest }, this.config.stateRoot)
    })
  }

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

  specView(batch: SpecBatch, offset = 0, limit = this.config.resultItems): SpecBatchView {
    if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer')
    if (!Number.isInteger(limit) || limit < 1 || limit > this.config.resultItems) throw new Error(`limit must be an integer from 1 to ${this.config.resultItems}`)
    const items = batch.items.slice(offset, offset + limit).map(item => ({
      id: item.id, relativePath: item.relativePath, outputPath: item.outputPath, status: item.status,
      ...(item.reason === undefined ? {} : { reason: item.reason }), evidenceCount: item.evidence.length, hasDraft: Boolean(item.draft),
    }))
    return {
      batch: {
        id: batch.id, revision: batch.revision, digest: batch.digest, sourceRoot: batch.sourceRoot, outputRoot: batch.outputRoot,
        samples: batch.samples, summary: batch.summary, instructions: batch.recipe.instructions,
        ...(batch.recipe.approvalRevision === undefined ? {} : { approvalRevision: batch.recipe.approvalRevision }),
        approvedSampleCount: batch.recipe.approvedSamples.length,
        ...(('discovery' in batch) ? { discovery: (batch as SpecBatch & { discovery?: unknown }).discovery } : {}),
      },
      items,
      page: { offset, returned: items.length, total: batch.items.length, ...(offset + items.length < batch.items.length ? { nextOffset: offset + items.length } : {}) },
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

  private async checkedPersistedSpecRoots(batch: SpecBatch): Promise<void> {
    const sourceRoot = await realpath(batch.sourceRoot)
    if (sourceRoot !== batch.sourceRoot || !within(this.config.workspaceRoot, sourceRoot) || !within(this.config.workspaceRoot, resolve(batch.outputRoot)) || overlaps(batch.outputRoot, this.config.stateRoot)) throw new Error('Saved specification batch roots are outside this DSH Ditto profile workspace')
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

function specCreateTool(service: DshDitto) {
  return defineTool({
    name: 'ditto_spec_create',
    description: 'Start one M1 code-to-specification batch for TypeScript/JavaScript modules. It reads a bounded repository and writes only local batch metadata; it never changes source files or Markdown output. The batch contains exactly three representative sample module ids. First use ditto_spec_queue with phase=samples, then ditto_spec_module to obtain source evidence and ditto_spec_submit to submit one structured model draft per sample. The plugin does not make a hidden model call: the current DSH agent must generate the draft from returned evidence.',
    parameters: {
      source_root: { type: 'string', required: true, description: 'Existing TypeScript/JavaScript repository folder, inside the configured Ditto workspace. It is read-only.' },
      output_root: { type: 'string', required: true, description: 'Fresh separate output folder, inside the configured Ditto workspace. Markdown specifications will be written here only after ditto_spec_apply.' },
      instructions: { type: 'string', description: 'Optional user-approved batch guidance, up to 8,000 characters. It is included in every agent-driven generation request and has no executable meaning.' },
    },
    output: jsonOutput,
    async execute(args, exec) {
      checkNotAborted(exec.signal)
      return json(service.specView(await service.createSpec({ sourceRoot: args.source_root, outputRoot: args.output_root, instructions: args.instructions }), 0))
    },
  })
}

function specQueueTool(service: DshDitto) {
  return defineTool({
    name: 'ditto_spec_queue',
    description: 'List bounded pending modules for one M1 specification phase, without changing files. Use phase=samples until all three samples have an explicit ditto_spec_approve approval for the current revision. Only then use phase=remaining. Any material ditto_spec_revise_samples edit clears that approval and locks remaining again. Returns module ids, proposed Markdown paths, structural facts, and a nextOffset for paging. For one selected module, call ditto_spec_module before creating its draft. If the batch identity is stale, call ditto_spec_status and restart from its current revision and digest.',
    parameters: {
      batch_id: { type: 'string', required: true, description: 'Batch id returned by ditto_spec_create or ditto_spec_status.' },
      phase: { type: 'string', required: true, enum: ['samples', 'remaining'], description: 'samples generates the three calibration examples. remaining becomes available only after all samples were approved.' },
      offset: { type: 'integer', description: 'Zero-based offset within this phase; default 0. Pass nextOffset to read the next page.' },
      limit: { type: 'integer', description: 'Maximum returned module records; default and maximum come from profile configuration.' },
    },
    output: jsonOutput,
    async execute(args, exec) {
      checkNotAborted(exec.signal)
      const batch = await service.specStatus(args.batch_id)
      const limit = args.limit ?? service.config.resultItems
      const offset = args.offset ?? 0
      if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer')
      if (!Number.isInteger(limit) || limit < 1 || limit > service.config.resultItems) throw new Error(`limit must be an integer from 1 to ${service.config.resultItems}`)
      if (args.phase === 'remaining' && !hasCurrentSpecApproval(batch)) throw new Error('Remaining modules are locked until ditto_spec_approve approves all three samples for the current revision; after any sample or instruction edit, review and approve again')
      const matching = batch.items.filter(item => args.phase === 'samples' ? batch.samples.includes(item.id) && ['pending', 'needs-review'].includes(item.status) : !batch.samples.includes(item.id) && ['pending', 'needs-review'].includes(item.status))
      const entries = matching.slice(offset, offset + limit).map(item => ({ id: item.id, relativePath: item.relativePath, outputPath: item.outputPath, status: item.status, facts: item.facts, evidenceCount: item.evidence.length }))
      return json({ batch: { id: batch.id, revision: batch.revision, digest: batch.digest }, phase: args.phase, items: entries, page: { offset, returned: entries.length, total: matching.length, ...(offset + entries.length < matching.length ? { nextOffset: offset + entries.length } : {}) } })
    },
  })
}

function specModuleTool(service: DshDitto) {
  return defineTool({
    name: 'ditto_spec_module',
    description: 'Get the bounded agent-generation context for one pending M1 module. Use an id from ditto_spec_queue. It returns real line-numbered evidence and deterministic facts, plus the explicitly approved current-revision sample recipes for remaining modules. Generate only a JSON SpecDraft whose moduleId matches this module and whose every factual field cites returned ev_ ids. Page evidence with nextEvidenceOffset; do not infer facts from evidence that was not returned. Remaining modules stay locked until ditto_spec_approve, and lock again after any material sample or instruction edit. Submit the completed JSON through ditto_spec_submit. This tool never calls a provider itself.',
    parameters: {
      batch_id: { type: 'string', required: true, description: 'Batch id returned by ditto_spec_create or ditto_spec_status.' },
      module_id: { type: 'string', required: true, description: 'A pending module id returned by ditto_spec_queue.' },
      evidence_offset: { type: 'integer', description: 'Zero-based evidence-chunk offset; default 0. Pass nextEvidenceOffset to continue.' },
      evidence_limit: { type: 'integer', description: 'Evidence chunks to return; default and maximum come from profile configuration.' },
    },
    output: jsonOutput,
    async execute(args, exec) {
      checkNotAborted(exec.signal)
      const batch = await service.specStatus(args.batch_id)
      const item = batch.items.find(candidate => candidate.id === args.module_id)
      if (!item || !['pending', 'needs-review'].includes(item.status)) throw new Error('The requested module is not pending a structured draft')
      const isSample = batch.samples.includes(item.id)
      if (!isSample && !hasCurrentSpecApproval(batch)) throw new Error('This remaining module is locked. Review and call ditto_spec_approve for all three current-revision samples before requesting it')
      const offset = args.evidence_offset ?? 0; const limit = args.evidence_limit ?? service.config.evidenceItems
      if (!Number.isInteger(offset) || offset < 0) throw new Error('evidence_offset must be a non-negative integer')
      if (!Number.isInteger(limit) || limit < 1 || limit > service.config.evidenceItems) throw new Error(`evidence_limit must be an integer from 1 to ${service.config.evidenceItems}`)
      const evidence = item.evidence.slice(offset, offset + limit)
      return json({
        batch: { id: batch.id, revision: batch.revision, digest: batch.digest },
        request: {
          module: { id: item.id, relativePath: item.relativePath, sourceHash: item.sourceHash, outputPath: item.outputPath, facts: item.facts, evidence },
          instructions: batch.recipe.instructions,
          approvedSamples: isSample ? [] : approvedSamples(batch.recipe.approvedSamples),
          draftContract: { version: 1, moduleId: item.id, requiredRule: 'Every factual field needs one or more evidence ids returned for this module. Unsupported or uncertain statements belong in confirmations as questions; related evidence ids are optional.' },
        },
        evidencePage: { offset, returned: evidence.length, total: item.evidence.length, ...(offset + evidence.length < item.evidence.length ? { nextEvidenceOffset: offset + evidence.length } : {}) },
      })
    },
  })
}

function specSubmitTool(service: DshDitto) {
  return defineTool({
    name: 'ditto_spec_submit',
    description: 'Validate and persist exactly one agent-produced M1 structured draft. It accepts JSON only, never Markdown or output paths. The draft must use version=1, exactly match module_id, and cite valid evidence ids from ditto_spec_module for factual claims. confirmations are questions and may have relatedEvidenceIds. Invalid citations, unsupported fields, or stale batch identity are rejected before any Markdown file is written. On error, call ditto_spec_status; for evidence errors, retrieve the module again and repair the JSON. Successful sample drafts become sample-ready; successful remaining drafts become ready for review/apply.',
    parameters: {
      batch_id: { type: 'string', required: true, description: 'Batch id from the latest ditto_spec_status, ditto_spec_queue, or ditto_spec_module result.' },
      revision: { type: 'integer', required: true, description: 'Exact latest batch revision. On mismatch, call ditto_spec_status.' },
      digest: { type: 'string', required: true, description: 'Exact latest batch digest. On mismatch, call ditto_spec_status.' },
      module_id: { type: 'string', required: true, description: 'Pending module id from ditto_spec_queue.' },
      draft: { type: 'json', required: true, description: 'One JSON SpecDraft. title, purpose, responsibilities, publicApi, dependencies, and errors use text plus citations. confirmations use question plus optional relatedEvidenceIds. Never include a path, Markdown, HTML, script, or command.' },
      metadata: { type: 'object', additionalProperties: true, description: 'Optional bounded string-only audit metadata about this agent-generated draft. Do not include credentials or provider secrets.' },
    },
    output: jsonOutput,
    async execute(args, exec) {
      checkNotAborted(exec.signal)
      return json(service.specView(await service.submitSpec(args.batch_id, args.revision, args.digest, args.module_id, args.draft, args.metadata as Record<string, string> | undefined), 0))
    },
  })
}

function specReviewTool(service: DshDitto) {
  return defineTool({
    name: 'ditto_spec_review',
    description: 'Read one generated M1 Markdown specification for user review without writing files. Use it after ditto_spec_submit for a sample before ditto_spec_approve, and for any ready module before ditto_spec_apply. It returns renderer-owned Markdown, its planned output path, and the evidence links it cites. For a calibration sample, use ditto_spec_revise_samples to save user edits before approval.',
    parameters: {
      batch_id: { type: 'string', required: true, description: 'Batch id returned by ditto_spec_create or ditto_spec_status.' },
      module_id: { type: 'string', required: true, description: 'A generated module id from ditto_spec_queue or ditto_spec_status.' },
    },
    output: jsonOutput,
    async execute(args, exec) {
      checkNotAborted(exec.signal)
      const batch = await service.specStatus(args.batch_id)
      const item = batch.items.find(candidate => candidate.id === args.module_id)
      if (!item || !item.renderedMarkdown) throw new Error('The requested module has no validated rendered specification to review')
      return json({ batch: { id: batch.id, revision: batch.revision, digest: batch.digest }, module: { id: item.id, relativePath: item.relativePath, outputPath: item.outputPath, status: item.status, markdown: item.approvedMarkdown ?? item.renderedMarkdown, renderedHash: item.renderedHash, evidence: item.evidence.map(chunk => ({ id: chunk.id, relativePath: chunk.relativePath, startLine: chunk.startLine, endLine: chunk.endLine })) } })
    },
  })
}

function specReviseTool(service: DshDitto) {
  return defineTool({
    name: 'ditto_spec_revise_samples',
    description: 'Persist user-reviewed Markdown edits for zero to three M1 calibration samples, and optionally replace batch instructions. A material edit changes the recipe revision, clears the prior approval, invalidates held-out drafts, and locks remaining generation until a new ditto_spec_approve. It never writes output specifications. Every factual Markdown line must retain a valid [ev_…] citation for that sample. Only submit edits the user actually requested or approved. After this tool, review the returned identity and call ditto_spec_approve when all three samples are ready.',
    parameters: {
      batch_id: { type: 'string', required: true, description: 'Batch id returned by ditto_spec_create or ditto_spec_status.' },
      revision: { type: 'integer', required: true, description: 'Exact latest batch revision.' },
      digest: { type: 'string', required: true, description: 'Exact latest batch digest.' },
      sample_edits: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { module_id: { type: 'string', required: true, description: 'One of the three sample module ids.' }, markdown: { type: 'string', required: true, description: 'User-reviewed Markdown for that sample. Preserve valid [ev_…] evidence citations on each factual line.' } } }, description: 'Optional edits for distinct calibration samples. Omit or use an empty list to change only instructions.' },
      instructions: { type: 'string', description: 'Optional replacement user-approved batch guidance, up to 8,000 characters.' },
    },
    output: jsonOutput,
    async execute(args, exec) {
      checkNotAborted(exec.signal)
      const sampleEdits = args.sample_edits?.map(edit => ({ moduleId: edit.module_id, markdown: edit.markdown }))
      return json(service.specView(await service.reviseSpec(args.batch_id, args.revision, args.digest, { sampleEdits, instructions: args.instructions }), 0))
    },
  })
}

function specApproveTool(service: DshDitto) {
  return defineTool({
    name: 'ditto_spec_approve',
    description: 'Record approval of all three displayed M1 calibration samples as a versioned, non-executable recipe. Call this only after the user has reviewed the rendered sample Markdown and explicitly approved it. It does not write Markdown outputs. It changes the batch revision and digest; use the returned identity when obtaining and submitting the remaining modules. If a sample needs editing, repair it through the product review surface before approval rather than inventing an unreviewed replacement here.',
    parameters: {
      batch_id: { type: 'string', required: true, description: 'Batch id returned by ditto_spec_create or ditto_spec_status.' },
      revision: { type: 'integer', required: true, description: 'Exact latest batch revision.' },
      digest: { type: 'string', required: true, description: 'Exact latest batch digest.' },
    },
    output: jsonOutput,
    async execute(args, exec) {
      checkNotAborted(exec.signal)
      return json(service.specView(await service.approveSpec(args.batch_id, args.revision, args.digest), 0))
    },
  })
}

function specApplyTool(service: DshDitto) {
  return defineTool({
    name: 'ditto_spec_apply',
    description: 'Write reviewed M1 Markdown specifications into the batch output root using the exact displayed revision and digest. Call only after the user approves the full batch preview. It rechecks every source hash, prevents traversal, symlink escapes, collisions, and overwrites, and records actual per-module outcomes for resume. It never edits source files. If rejected as stale, call ditto_spec_status and obtain renewed user review; if a source changed, create a new batch.',
    parameters: {
      batch_id: { type: 'string', required: true, description: 'Batch id returned by ditto_spec_create or ditto_spec_status.' },
      revision: { type: 'integer', required: true, description: 'Exact reviewed batch revision.' },
      digest: { type: 'string', required: true, description: 'Exact reviewed batch digest.' },
    },
    output: jsonOutput,
    async execute(args, exec) {
      checkNotAborted(exec.signal)
      const result = await service.applySpec(args.batch_id, args.revision, args.digest)
      checkNotAborted(exec.signal)
      return json({ result: { batchId: result.batchId, revision: result.revision, digest: result.digest, summary: result.summary }, ...service.specView(await service.specStatus(args.batch_id), 0) })
    },
  })
}

function specStatusTool(service: DshDitto) {
  return defineTool({
    name: 'ditto_spec_status',
    description: 'Read one durable M1 specification batch without changing files. Returns actual per-module statuses, discovery/exclusion accounting when available, and a bounded page with nextOffset. Use it after any stale, validation, or interrupted-apply error to recover the current revision and digest before retrying.',
    parameters: {
      batch_id: { type: 'string', required: true, description: 'Batch id returned by ditto_spec_create.' },
      offset: { type: 'integer', description: 'Zero-based module offset; default 0. Pass nextOffset to continue.' },
      limit: { type: 'integer', description: 'Module count; default and maximum come from profile configuration.' },
    },
    output: jsonOutput,
    async execute(args, exec) {
      checkNotAborted(exec.signal)
      return json(service.specView(await service.specStatus(args.batch_id), args.offset ?? 0, args.limit ?? service.config.resultItems))
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
  const evidenceItems = config.evidenceItems ?? 20
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 1_000) throw new Error('DSH Ditto maxItems must be an integer from 1 to 1000')
  if (!Number.isInteger(resultItems) || resultItems < 1 || resultItems > 100) throw new Error('DSH Ditto resultItems must be an integer from 1 to 100')
  if (!Number.isInteger(evidenceItems) || evidenceItems < 1 || evidenceItems > 40) throw new Error('DSH Ditto evidenceItems must be an integer from 1 to 40')
  return { workspaceRoot, stateRoot, maxItems, resultItems, evidenceItems }
}

function within(root: string, target: string): boolean {
  const path = relative(resolve(root), resolve(target))
  return path === '' || (path !== '..' && !path.startsWith('..\\') && !path.startsWith('../'))
}

function overlaps(a: string, b: string): boolean { return within(a, b) || within(b, a) }

function assertSpecIdentity(batch: SpecBatch, revision: number, digest: string): void {
  if (!Number.isInteger(revision) || batch.revision !== revision || typeof digest !== 'string' || batch.digest !== digest) throw new Error('Specification batch changed after review; call ditto_spec_status and retry with its current revision and digest')
}

/** Mirrors the core's current-recipe gate so native tools never expose stale few-shot examples. */
function hasCurrentSpecApproval(batch: SpecBatch): boolean {
  const approved = batch.recipe.approvedSamples.map(sample => sample.moduleId).sort()
  return batch.recipe.approvalRevision === batch.revision
    && approved.length === 3
    && new Set(approved).size === 3
    && approved.join('\u0000') === [...batch.samples].sort().join('\u0000')
    && batch.samples.every(id => {
      const item = batch.items.find(candidate => candidate.id === id)
      const sample = batch.recipe.approvedSamples.find(candidate => candidate.moduleId === id)
      return item?.status === 'approved' && item.approvedMarkdown === sample?.markdown
    })
}

/** Core validates the three approved recipes against the shared 12k bound. Never truncate reviewed content here. */
function approvedSamples(samples: Array<{ moduleId: string; markdown: string }>): Array<{ moduleId: string; markdown: string }> {
  if (samples.length > 3 || samples.some(sample => sample.markdown.length > 12_000)) throw new Error('Approved sample recipe exceeds the supported native-tool context bound; reload batch status and revise the sample')
  return samples.map(sample => ({ moduleId: sample.moduleId, markdown: sample.markdown }))
}

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
