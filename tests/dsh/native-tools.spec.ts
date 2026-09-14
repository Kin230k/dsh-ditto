import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { DshDitto } from '../../src/dsh/index.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('DSH Ditto native tools on published Cordis + ToolRuntime', () => {
  it('registers through the real ToolRuntime, obeys pre-dispatch denials, and only copies after an exact review', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-ditto-native-'))
    roots.push(root)
    const source = join(root, 'incoming')
    const output = join(root, 'organized')
    const state = join(root, '.dsh-ditto-state')
    await mkdir(source)
    await writeFile(join(source, 'invoice.txt'), 'unchanged source', { encoding: 'utf8' })

    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, { mode: 'native' })
    await ctx.plugin(DshDitto, { workspaceRoot: root, stateRoot: state, maxItems: 20, resultItems: 10 })

    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(expect.arrayContaining([
      'ditto_preview', 'ditto_revise', 'ditto_apply', 'ditto_status', 'ditto_recipe',
    ]))

    const preview = await call(ctx, 'ditto_preview', { source_root: source, destination_root: output, pattern: '整理-{stem}' })
    expect(preview.isError).toBe(false)
    const previewValue = value(preview)
    let plan = previewValue.plan as { id: string; revision: number; digest: string }
    expect(previewValue.items).toHaveLength(1)
    expect(await readFile(join(source, 'invoice.txt'), 'utf8')).toBe('unchanged source')

    const pageItem = (previewValue.items as Array<{ id: string }>)[0]!
    const revised = value(await call(ctx, 'ditto_revise', { plan_id: plan.id, revision: plan.revision, edits: [{ id: pageItem.id, destination: '文字/已確認-invoice.txt' }] }))
    plan = revised.plan as typeof plan
    expect(plan.revision).toBe(2)
    expect(value(await call(ctx, 'ditto_status', { plan_id: plan.id, offset: 0, limit: 1 })).page).toMatchObject({ total: 1, returned: 1 })

    const savedRecipe = value(await call(ctx, 'ditto_recipe', { action: 'save', plan_id: plan.id, name: '發票整理' }))
    const recipeId = (savedRecipe.recipe as { id: string }).id
    expect(value(await call(ctx, 'ditto_recipe', { action: 'list' })).recipes).toEqual(expect.arrayContaining([expect.objectContaining({ id: recipeId })]))
    expect((value(await call(ctx, 'ditto_recipe', { action: 'get', recipe_id: recipeId })).recipe as { id: string }).id).toBe(recipeId)

    const guard = ctx.tools.guard(exec => exec.name === 'ditto_apply' ? 'test guard denies copy' : undefined)
    const guarded = await call(ctx, 'ditto_apply', { plan_id: plan.id, revision: plan.revision, digest: plan.digest })
    expect(guarded.isError).toBe(true)
    await expect(readFile(join(output, '文字', '已確認-invoice.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    guard()

    const preExecute = ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'ditto_apply' ? { kind: 'deny', reason: 'test pre-execute denies copy' } : next())
    const denied = await call(ctx, 'ditto_apply', { plan_id: plan.id, revision: plan.revision, digest: plan.digest })
    expect(denied.isError).toBe(true)
    await expect(readFile(join(output, '文字', '已確認-invoice.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    preExecute()

    const applied = await call(ctx, 'ditto_apply', { plan_id: plan.id, revision: plan.revision, digest: plan.digest })
    expect(applied.isError).toBe(false)
    expect(await readFile(join(output, '文字', '已確認-invoice.txt'), 'utf8')).toBe('unchanged source')
    expect(await readFile(join(source, 'invoice.txt'), 'utf8')).toBe('unchanged source')

    // State lives beside the input. A later preview therefore sees only the real source.
    const again = value(await call(ctx, 'ditto_preview', { source_root: source, destination_root: join(root, 'organized-again') }))
    expect(again.page).toMatchObject({ total: 1 })
    await ctx.fiber.dispose()
  })

  it('excludes durable state when a source folder contains it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-ditto-native-'))
    roots.push(root)
    const source = join(root, 'incoming')
    const state = join(source, '.dsh-ditto-state')
    await mkdir(state, { recursive: true })
    await writeFile(join(source, 'one.txt'), 'one', { encoding: 'utf8' })
    await writeFile(join(state, 'old-plan.json'), 'not a source file', { encoding: 'utf8' })
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, { mode: 'native' })
    await ctx.plugin(DshDitto, { workspaceRoot: root, stateRoot: state })
    const result = value(await call(ctx, 'ditto_preview', { source_root: source, destination_root: join(root, 'output') }))
    expect(result.page).toMatchObject({ total: 1 })
    await ctx.fiber.dispose()
  })
})

let callNumber = 0
async function call(ctx: Context, name: string, arguments_: unknown) {
  return ctx.tools.execute({ callId: `native-${++callNumber}` as never, name, arguments: arguments_, signal: new AbortController().signal })
}

function value(result: Awaited<ReturnType<ToolRuntime['execute']>>): Record<string, unknown> {
  if (result.isError) throw new Error(result.error.message)
  return result.value as Record<string, unknown>
}
