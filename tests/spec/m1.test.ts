import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applySpecBatch, approveSpecSamples, chooseSamples, createSpecBatch, generateSpecBatch, MAX_REVIEWED_SAMPLE_MARKDOWN, reviseSpecBatch, saveSpecBatch, submitSpecDraft, validateReviewedMarkdown, withSpecDigest, type SpecGenerationRequest, type SpecGenerator, type SpecModule } from '../../src/core/index.js'

const roots: string[] = []
async function fixture(): Promise<{ root: string; source: string; output: string; state: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ditto-m1-')); roots.push(root)
  const source = join(root, 'source'); const output = join(root, 'specifications'); const state = join(root, 'state')
  const modules = Array.from({ length: 12 }, (_, index) => [`src/module-${index + 1}.ts`, index % 3 === 0 ? `import { helper } from './helper.js'\nexport function item${index + 1}(value: string) { return helper(value) }\n` : index % 3 === 1 ? `export class Item${index + 1} { value = ${index + 1} }\n` : `export type Item${index + 1} = { id: string }\n`])
  for (const [relativePath, content] of modules) { const file = join(source, ...relativePath.split('/')); await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, content, 'utf8') }
  await writeFile(join(source, 'README.md'), 'not source', 'utf8'); await mkdir(join(source, 'node_modules'), { recursive: true })
  return { root, source, output, state }
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

/** Deterministic fake generator for tests/demo only. It does not claim model quality. */
function fakeGenerator(requests: SpecGenerationRequest[]): SpecGenerator {
  return { id: 'fake-generator-test-only', async generate(request) { requests.push(request); const evidence = request.module.evidence[0]; return { draft: { version: 1, moduleId: request.module.id, purpose: { text: `說明 ${request.module.relativePath}`, citations: [evidence.id] }, publicApi: request.module.facts.exports.slice(0, 1).map(name => ({ kind: 'value' as const, name, text: `匯出 ${name}`, citations: [evidence.id] })) }, metadata: { mode: 'fake-test-only' } } } }
}

describe('M1 evidence-backed specifications', () => {
  it('scans a bounded 12-module batch, calibrates three samples, and writes reviewed Markdown only', async () => {
    const paths = await fixture(); const before = await readFile(join(paths.source, 'src', 'module-1.ts'))
    const embeddedState = join(paths.source, '.ditto-state'); await mkdir(embeddedState); await writeFile(join(embeddedState, 'ignored.ts'), 'export const ignored = true', 'utf8')
    let batch = await createSpecBatch({ sourceRoot: paths.source, outputRoot: paths.output, stateRoot: embeddedState })
    expect(batch.items).toHaveLength(12); expect(batch.samples).toHaveLength(3); expect(batch.discovery.excludedByReason['non-code']).toBe(1); expect(batch.discovery.excludedByReason['ignored-folder']).toBe(1); expect(batch.discovery.excludedByReason['state-folder']).toBe(1)
    const requests: SpecGenerationRequest[] = []; const fake = fakeGenerator(requests)
    batch = await generateSpecBatch(batch, fake, { only: 'samples', stateRoot: paths.state })
    expect(batch.summary.sampleReady).toBe(3); const oldDigest = batch.digest
    const first = batch.items.find(item => item.id === batch.samples[0])!; const evidenceId = first.evidence[0].id
    batch = reviseSpecBatch(batch, { instructions: '保留公開 API；未知資訊要標成待確認。', sampleEdits: [{ moduleId: first.id, markdown: `${first.renderedMarkdown}\n- 人工校準內容 [${evidenceId}]\n` }] })
    batch = approveSpecSamples(batch); expect(batch.digest).not.toBe(oldDigest); expect(() => validateReviewedMarkdown(first.renderedMarkdown, first)).not.toThrow()
    expect(() => validateReviewedMarkdown('x'.repeat(MAX_REVIEWED_SAMPLE_MARKDOWN + 1), first)).toThrow('12000')
    batch = await generateSpecBatch(batch, fake, { only: 'remaining', stateRoot: paths.state })
    expect(batch.summary.ready).toBe(9); const heldOut = requests.find(request => !batch.samples.includes(request.module.id))!; expect(heldOut.approvedSamples).toHaveLength(3); expect(heldOut.approvedSamples.some(sample => sample.markdown.includes('人工校準內容'))).toBe(true)
    await saveSpecBatch(batch, paths.state)
    const result = await applySpecBatch(batch, { id: batch.id, revision: batch.revision, digest: batch.digest }, paths.state)
    expect(result.summary.applied).toBe(12); expect(await readFile(join(paths.output, ...first.outputPath.split('/')), 'utf8')).toContain('人工校準內容'); expect(await readFile(join(paths.source, 'src', 'module-1.ts'))).toEqual(before)
  })

  it('chooses three unique structurally different samples even when score and export ordering disagree', () => {
    const item = (id: string, exports: string[], imports: string[], lineCount: number): SpecModule => ({ id, source: `C:/source/${id}.ts`, relativePath: `${id}.ts`, sourceHash: 'a'.repeat(64), outputPath: `${id}.md`, evidence: [{ id: `ev_${id.padEnd(24, '0').slice(0, 24)}`, relativePath: `${id}.ts`, startLine: 1, endLine: 1, contentHash: 'b'.repeat(64), text: 'export {}' }], facts: { exports, imports, lineCount }, status: 'pending' })
    const exportsTop = item('export-top', ['a', 'b'], [], 100)
    const scoreTop = item('score-top', ['a'], ['one', 'two', 'three'], 10)
    const imported = item('imported', [], ['one'], 1)
    const sampleIds = chooseSamples([exportsTop, scoreTop, imported]).sort()
    expect(sampleIds).toHaveLength(3); expect(new Set(sampleIds).size).toBe(3); expect(sampleIds).toEqual(['export-top', 'imported', 'score-top'])
  })

  it('generates only calibration samples by default and cannot unlock held-out modules with stale approvals', async () => {
    const paths = await fixture(); const requests: SpecGenerationRequest[] = []; const fake = fakeGenerator(requests)
    let batch = await createSpecBatch({ sourceRoot: paths.source, outputRoot: paths.output })
    batch = await generateSpecBatch(batch, fake)
    expect(batch.summary.sampleReady).toBe(3); expect(batch.summary.pending).toBe(9); expect(requests).toHaveLength(3)
    batch = approveSpecSamples(batch)
    const forged = withSpecDigest({ ...batch, digest: '', recipe: { ...batch.recipe, approvedSamples: batch.recipe.approvedSamples.map(sample => ({ ...sample, moduleId: `old-${sample.moduleId}` })) } })
    await expect(generateSpecBatch(forged, fake, { only: 'remaining' })).rejects.toThrow('核准樣本')
  })

  it('requires explicit approval, invalidates held-out drafts on recalibration, and locks a written batch', async () => {
    const paths = await fixture(); const requests: SpecGenerationRequest[] = []; const fake = fakeGenerator(requests)
    let batch = await createSpecBatch({ sourceRoot: paths.source, outputRoot: paths.output })
    batch = await generateSpecBatch(batch, fake)
    const edits = batch.samples.map(id => { const item = batch.items.find(candidate => candidate.id === id)!; return { moduleId: id, markdown: item.renderedMarkdown! } })
    batch = reviseSpecBatch(batch, { sampleEdits: edits })
    expect(batch.recipe.approvedSamples).toEqual([]); expect(batch.items.filter(item => batch.samples.includes(item.id)).every(item => item.status === 'sample-ready')).toBe(true)
    await expect(generateSpecBatch(batch, fake, { only: 'remaining' })).rejects.toThrow('核准目前')
    batch = approveSpecSamples(batch)
    expect(batch.recipe.approvalRevision).toBe(batch.revision); expect(batch.items.filter(item => batch.samples.includes(item.id)).every(item => item.status === 'approved')).toBe(true)
    await saveSpecBatch(batch, paths.state)
    await expect(applySpecBatch(batch, { id: batch.id, revision: batch.revision, digest: batch.digest }, paths.state)).rejects.toThrow('完整批次預覽尚未完成')
    batch = await generateSpecBatch(batch, fake, { only: 'remaining' }); expect(batch.summary.ready).toBe(9)
    batch = reviseSpecBatch(batch, { instructions: '變更後的批次說明。' })
    expect(batch.recipe.approvedSamples).toEqual([]); expect(batch.items.filter(item => !batch.samples.includes(item.id)).every(item => item.status === 'pending' && !item.draft && !item.renderedMarkdown && !item.generation)).toBe(true)
    await saveSpecBatch(batch, paths.state)
    await expect(applySpecBatch(batch, { id: batch.id, revision: batch.revision, digest: batch.digest }, paths.state)).rejects.toThrow('完整批次預覽尚未完成')
    batch = approveSpecSamples(batch); batch = await generateSpecBatch(batch, fake, { only: 'remaining' }); await saveSpecBatch(batch, paths.state)
    const result = await applySpecBatch(batch, { id: batch.id, revision: batch.revision, digest: batch.digest }, paths.state)
    expect(result.summary.applied).toBe(12)
    const persistedApplied = { ...batch, items: result.items, summary: result.summary }
    expect(() => reviseSpecBatch(persistedApplied, { instructions: '寫入後不能改。' })).toThrow('已有寫入結果')
  })

  it('rejects hallucinated evidence before preview/write and rejects stale sources at apply', async () => {
    const paths = await fixture(); let batch = await createSpecBatch({ sourceRoot: paths.source, outputRoot: paths.output })
    const target = batch.items[0]
    expect(() => submitSpecDraft(batch, { moduleId: target.id, draft: { version: 1, moduleId: target.id, purpose: { text: 'invented', citations: ['ev_000000000000000000000000'] } } })).toThrow('證據')
    const requests: SpecGenerationRequest[] = []; batch = await generateSpecBatch(batch, fakeGenerator(requests), { only: 'samples' }); batch = approveSpecSamples(batch); batch = await generateSpecBatch(batch, fakeGenerator(requests), { only: 'remaining' })
    await saveSpecBatch(batch, paths.state); await writeFile(target.source, 'changed after preview', 'utf8')
    await expect(applySpecBatch(batch, { id: batch.id, revision: batch.revision, digest: batch.digest }, paths.state)).rejects.toThrow('來源檔案在預覽後已變更')
    await expect(readFile(join(paths.output, ...target.outputPath.split('/')))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(paths.output, 'src', 'module-12.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
