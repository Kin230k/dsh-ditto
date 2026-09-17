import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DshDitto } from '../service.js'
import { checkNotAborted, json, jsonOutput, requireHumanApproval } from './shared.js'

/** Native tools for the reviewed file-organisation workflow: preview → revise → apply → status, plus saved recipes. */
export function fileTools(service: DshDitto) {
  return [previewTool(service), reviseTool(service), applyTool(service), statusTool(service), recipeTool(service)]
}

function previewTool(service: DshDitto) {
  return defineTool({
    name: 'ditto_preview',
    description: 'Create a read-only Ditto preview for organising a batch of files inside the configured workspace. This writes only durable local review metadata, never source files or output copies. Returns the reviewed plan identity, digest, summary, and the first bounded page of proposed names; use ditto_status for later pages. Review the proposed names and exceptions with the user before ditto_apply.',
    parameters: {
      source_root: { type: 'string', required: true, description: 'Existing source folder inside the Ditto workspace. It is read-only.' },
      destination_root: { type: 'string', required: true, description: 'New output folder inside the Ditto workspace. It must be outside source_root and never overlap Ditto state metadata.' },
      recipe_name: { type: 'string', description: 'Optional 1–80 character label for this draft rule.' },
      pattern: { type: 'string', description: 'Optional declarative filename pattern. Only {stem}, {ext}, {index}, and {class} are substituted; for example "2026-{stem}" or "{index}-{class}-{stem}". It cannot contain paths, scripts, or shell commands.' },
      classification: { type: 'string', enum: ['folder-prefix', 'none'], description: 'Whether copies are grouped under a deterministic classification folder (documents, images, text, other).' },
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
    description: 'Revise reviewed Ditto output-relative destination names. This never copies files. Returns a new revision and digest plus the first page; if the revision is stale, call ditto_status and re-review before retrying. If destinations collide, choose unique names and call ditto_revise again.',
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
    description: 'Create copies using exactly one reviewed Ditto plan. Call it only after the user has approved the displayed batch; when the DSH host has an approval service, the host asks the user once more before anything is written. The digest proves plan identity and freshness; it is not human-approval proof. Originals remain untouched and completed output copies are never overwritten. Returns actual statuses and only the first bounded item page; use ditto_status with nextOffset for the rest. A stale revision or digest requires ditto_status and renewed review; a changed source requires a new ditto_preview.',
    parameters: {
      plan_id: { type: 'string', required: true, description: 'Plan id returned by ditto_preview or ditto_status.' },
      revision: { type: 'integer', required: true, description: 'Exact current revision. If rejected as stale, call ditto_status before any retry.' },
      digest: { type: 'string', required: true, description: 'Exact review digest returned by ditto_preview, ditto_revise, or ditto_status.' },
    },
    output: jsonOutput,
    async execute(args, exec) {
      checkNotAborted(exec.signal)
      const plan = await service.status(args.plan_id)
      const approval = await requireHumanApproval({ ctx: service.host, mode: service.config.approval, exec, toolName: 'ditto_apply', reason: `Create ${plan.summary.ready} organised copies in ${plan.destinationRoot} (plan ${plan.id}, revision ${plan.revision}). Source files are never modified.` })
      checkNotAborted(exec.signal)
      const result = await service.apply(args.plan_id, args.revision, args.digest)
      checkNotAborted(exec.signal)
      const current = await service.status(args.plan_id)
      return json({ result: { planId: result.planId, revision: result.revision, digest: result.digest, summary: result.summary, approval }, ...service.view(current, 0) })
    },
  })
}

function statusTool(service: DshDitto) {
  return defineTool({
    name: 'ditto_status',
    description: 'Read the current durable Ditto plan and actual per-item statuses without changing files. Returns a bounded page and nextOffset when more items remain. Use it to recover the current revision/digest after a stale mutation error or an interrupted apply.',
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
    description: 'Save a reviewed Ditto plan as a versioned declarative recipe, list saved recipe summaries, or read one saved recipe. Recipes contain no shell commands, scripts, or executable code. action=save requires plan_id and name and returns the saved recipe; action=list returns summaries; action=get requires recipe_id and returns that recipe.',
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
