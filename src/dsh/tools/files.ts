import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DshDitto } from '../service.js'
import { checkNotAborted, json, jsonOutput, requireHumanApproval } from './shared.js'

/** Native tools for the reviewed file-organisation workflow: preview → revise rule/items → manifest → artifact review → apply → status, plus saved recipes. */
export function fileTools(service: DshDitto) {
  return [previewTool(service), reviseTool(service), reviseRuleTool(service), manifestTool(service), artifactReviewTool(service), applyTool(service), statusTool(service), recipeTool(service)]
}

function previewTool(service: DshDitto) {
  return defineTool({
    name: 'ditto_preview',
    description: 'Create a read-only Ditto preview for organising a batch of files inside profile-authorised source and destination roots. This writes only durable local review metadata, never source files or output copies. It may include reviewed sidecars and an optional ZIP. Returns the reviewed plan identity, digest, diagnostics, and the first bounded page; use ditto_status for later pages. Review names, exceptions, artifacts, and archive before ditto_apply.',
    parameters: {
      source_root: { type: 'string', required: true, description: 'Existing read-only source folder inside a profile-authorised source root.' },
      destination_root: { type: 'string', required: true, description: 'New output folder inside a profile-authorised destination root. It must be outside source_root and never overlap Ditto state metadata.' },
      recipe_name: { type: 'string', description: 'Optional 1–80 character label for this draft rule.' },
      pattern: { type: 'string', description: 'Optional declarative filename pattern. Only {stem}, {ext}, {index}, and {class} are substituted; for example "2026-{stem}" or "{index}-{class}-{stem}". It cannot contain paths, scripts, or shell commands.' },
      classification: { type: 'string', enum: ['folder-prefix', 'none'], description: 'Whether copies are grouped under a deterministic classification folder (documents, images, text, other).' },
      sidecars: { type: 'array', description: 'Optional reviewed sidecars to include from the first preview: deterministic manifest, checksums, or safe sql-insert text files. Each entry has the same declarative shape accepted by ditto_revise_rule.', items: { type: 'object', additionalProperties: true } },
      archive: { type: 'object', description: 'Optional reviewed ZIP of every successful output, for example {kind:"zip", destination:"bundle.zip"}. It is built only from reviewed outputs.', additionalProperties: true },
      max_items: { type: 'integer', description: 'Optional cap, from 1 to the profile maximum.' },
    },
    output: jsonOutput,
    async execute(args, exec) {
      checkNotAborted(exec.signal)
      const plan = await service.preview({
        sourceRoot: args.source_root, destinationRoot: args.destination_root,
        recipeName: args.recipe_name, pattern: args.pattern, classification: args.classification,
        ...(args.sidecars === undefined ? {} : { sidecars: args.sidecars as never }),
        ...(args.archive === undefined ? {} : { archive: args.archive as never }),
        maxItems: args.max_items,
      })
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

function reviseRuleTool(service: DshDitto) {
  return defineTool({
    name: 'ditto_revise_rule',
    description: 'Revise the whole declarative rule of a reviewed Ditto plan (match regex, scope, flags, destination pattern, classification) and regenerate every proposal and exception deterministically. This never copies files and is the tool to use instead of editing dozens of items one by one. Rejected once any item has apply intent or an outcome. Returns a new revision and digest plus the bounded first page; a stale revision requires ditto_status and renewed review.',
    parameters: {
      plan_id: { type: 'string', required: true, description: 'Plan id returned by ditto_preview or ditto_status.' },
      revision: { type: 'integer', required: true, description: 'Exact current plan revision returned by ditto_preview, ditto_revise_rule, or ditto_status.' },
      pattern: { type: 'string', description: 'New output-root-relative destination template. Supports {stem}, {ext} (the extension including its dot), {index}, {class}, and {match.<name>} for named captures, and may contain reviewed subfolders, for example "PRO/PRO_FILES/{match.code}/{match.code}{ext}". Never a script or shell command.' },
      match_regex: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'New anchored named-capture regular expression, for example "^(?<code>[^_]+)_.*\\.pdf$". Evaluated by a linear-time engine; backreferences, lookarounds, alternation, and nested quantifiers are rejected. Pass null to remove the match rule.' },
      match_scope: { type: 'string', enum: ['basename', 'relative-path'], description: 'Whether match_regex runs against the file name or the workspace-relative path with forward slashes.' },
      match_flags: { type: 'string', description: "Only 'i' and 'u' are accepted." },
      classification: { type: 'string', enum: ['folder-prefix', 'none'], description: 'Whether copies are grouped under a deterministic classification folder.' },
      preserve_overrides: { type: 'boolean', description: 'Keep the currently reviewed per-source overrides as explicit rule overrides. Default false: the regenerated proposal replaces them.' },
      sidecars: { type: 'array', description: 'Replace the reviewed sidecars with this list. Each entry writes a deterministic text file into the output folder: {kind:"manifest", destination:"REVIEW.csv", format:"csv"|"json"|"markdown"}, {kind:"checksums", destination:"SHA256SUMS.txt"}, or {kind:"sql-insert", destination:"INIT.sql", sql:{dialect:"sqlserver"|"postgres"|"sqlite", schema, table, columns:[...], values:{COLUMN:"template"}}}. SQL identifiers are strictly validated and template values become escaped literals only; no raw SQL, comment, or batch separator is accepted. Pass an empty array to remove all sidecars.', items: { type: 'object', additionalProperties: true } },
      archive: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }], description: 'Set a reviewed ZIP of every successful output, for example {kind:"zip", destination:"bundle.zip"}. Pass null to remove it. The archive is built only from the reviewed outputs, never by walking the output folder.' },
    },
    output: jsonOutput,
    async execute(args, exec) {
      checkNotAborted(exec.signal)
      const plan = await service.reviseRule(args.plan_id, args.revision, {
        ...(args.pattern === undefined ? {} : { pattern: args.pattern }),
        ...(args.match_regex === undefined ? {} : { matchRegex: args.match_regex }),
        ...(args.match_scope === undefined ? {} : { matchScope: args.match_scope }),
        ...(args.match_flags === undefined ? {} : { matchFlags: args.match_flags }),
        ...(args.classification === undefined ? {} : { classification: args.classification }),
        ...(args.preserve_overrides === undefined ? {} : { preserveOverrides: args.preserve_overrides }),
        ...(args.sidecars === undefined ? {} : { sidecars: args.sidecars as never }),
        ...(args.archive === undefined ? {} : { archive: args.archive as never }),
      })
      return json(service.view(plan, 0))
    },
  })
}

function manifestTool(service: DshDitto) {
  return defineTool({
    name: 'ditto_manifest',
    description: 'Export the complete reviewed mapping of a Ditto plan as one downloadable document under Ditto state (never into the output folder), so a large batch does not have to be read page by page. Requires the exact current plan id, revision, and digest. Returns the file path, byte count, SHA-256, and row count; use the path with the host file tools to show the user the document.',
    parameters: {
      plan_id: { type: 'string', required: true, description: 'Plan id returned by ditto_preview or ditto_status.' },
      revision: { type: 'integer', required: true, description: 'Exact current plan revision.' },
      digest: { type: 'string', required: true, description: 'Exact current plan digest.' },
      format: { type: 'string', enum: ['csv', 'json', 'markdown'], description: 'Document format. Default csv, whose formula-looking cells are neutralised.' },
    },
    output: jsonOutput,
    async execute(args, exec) {
      checkNotAborted(exec.signal)
      return json(await service.manifest(args.plan_id, args.revision, args.digest, args.format ?? 'csv'))
    },
  })
}

function artifactReviewTool(service: DshDitto) {
  return defineTool({
    name: 'ditto_artifact_review',
    description: 'Read the exact bytes of one reviewed sidecar of a Ditto plan before apply, in bounded pages. Requires the exact current plan id, revision, and digest plus the sidecar id from the plan view. Returns the sidecar metadata, the page, and nextOffset; the content always matches the hash that is part of the reviewed plan digest.',
    parameters: {
      plan_id: { type: 'string', required: true, description: 'Plan id returned by ditto_preview or ditto_status.' },
      revision: { type: 'integer', required: true, description: 'Exact current plan revision.' },
      digest: { type: 'string', required: true, description: 'Exact current plan digest.' },
      artifact_id: { type: 'string', required: true, description: 'Sidecar id from the plan view.' },
      offset: { type: 'integer', description: 'Zero-based character offset; default 0. Pass nextOffset to continue.' },
      limit: { type: 'integer', description: 'Characters to return, 1–8000; default 4000.' },
    },
    output: jsonOutput,
    async execute(args, exec) {
      checkNotAborted(exec.signal)
      return json(await service.artifactReview(args.plan_id, args.revision, args.digest, args.artifact_id, args.offset ?? 0, args.limit ?? 4_000))
    },
  })
}

function applyTool(service: DshDitto) {
  return defineTool({
    name: 'ditto_apply',
    description: 'Create copies using exactly one reviewed Ditto plan. Call it only after the user has approved the displayed batch; when the DSH host has an approval service, the host asks the user once more before anything is written. The digest proves plan identity and freshness; it is not human-approval proof. Originals remain untouched and completed output copies are never overwritten. Returns actual statuses, explicit output deliverables (including sidecars and archive), and only the first bounded item page; use ditto_status with nextOffset for the rest. A stale revision or digest requires ditto_status and renewed review; a changed source requires a new ditto_preview.',
    parameters: {
      plan_id: { type: 'string', required: true, description: 'Plan id returned by ditto_preview or ditto_status.' },
      revision: { type: 'integer', required: true, description: 'Exact current revision. If rejected as stale, call ditto_status before any retry.' },
      digest: { type: 'string', required: true, description: 'Exact review digest returned by ditto_preview, ditto_revise, or ditto_status.' },
    },
    output: jsonOutput,
    async execute(args, exec) {
      checkNotAborted(exec.signal)
      // Validate the caller's exact reviewed identity before asking the user to
      // approve, so a stale request can never display a newer plan's counts.
      const plan = await service.reviewApply(args.plan_id, args.revision, args.digest)
      // A plan persisted before 0.2 has no `artifacts` array at all.
      const artifacts = plan.artifacts ?? []
      const sidecars = artifacts.length === 0 ? 'no sidecars' : `${artifacts.length} reviewed sidecar(s): ${artifacts.map(artifact => artifact.destination).join(', ')}`
      const archive = plan.archive === undefined ? 'no archive' : `reviewed ZIP: ${plan.archive.destination}`
      const approval = await requireHumanApproval({ ctx: service.host, mode: service.config.approval, unavailable: service.config.approvalUnavailable, exec, toolName: 'ditto_apply', reason: `Create ${plan.summary.ready} organised copies in ${plan.destinationRoot} (plan ${plan.id}, revision ${plan.revision}); ${plan.summary.exception} source(s) remain reviewable exceptions and will not be copied; ${sidecars}; ${archive}. Source files are never modified.` })
      checkNotAborted(exec.signal)
      const result = await service.apply(args.plan_id, args.revision, args.digest)
      checkNotAborted(exec.signal)
      const current = await service.status(args.plan_id)
      return json({ result: { planId: result.planId, revision: result.revision, digest: result.digest, summary: result.summary, artifacts: result.artifacts, deliverables: result.deliverables, approval }, ...service.view(current, 0) })
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
