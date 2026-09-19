import { readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertNoLinkAncestor, assertNoLinkAncestorSync, createPlan, createSpecBatch, defaultRecipe } from '../../src/core/index.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('output folders must be separate from the source', () => {
  it('rejects a file-organisation output inside or equal to the source folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-ditto-bounds-')); roots.push(root)
    const source = join(root, 'source'); await mkdir(source); await writeFile(join(source, 'a.txt'), 'a', 'utf8')
    await expect(createPlan({ sourceRoot: source, destinationRoot: join(source, 'out'), recipe: defaultRecipe() })).rejects.toThrow('outside the source folder')
    await expect(createPlan({ sourceRoot: source, destinationRoot: source, recipe: defaultRecipe() })).rejects.toThrow('outside the source folder')
  })

  it('rejects a specification output inside the source folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-ditto-bounds-')); roots.push(root)
    const source = join(root, 'repo'); await mkdir(source)
    for (let index = 0; index < 4; index++) await writeFile(join(source, `m${index}.ts`), `export const m${index} = ${index}\n`, 'utf8')
    await expect(createSpecBatch({ sourceRoot: source, outputRoot: join(source, 'docs') })).rejects.toThrow('outside the source folder')
  })

  it('preserves Windows extended roots while checking junction ancestors', async () => {
    if (process.platform !== 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'dsh-ditto-extended-')); roots.push(root)
    const outside = await mkdtemp(join(tmpdir(), 'dsh-ditto-extended-outside-')); roots.push(outside)
    const link = join(root, 'linked')
    await symlink(outside, link, 'junction')
    const extended = `\\\\?\\${join(link, 'nested')}`
    await expect(assertNoLinkAncestor(extended)).rejects.toThrow('symlink or junction')
    expect(() => assertNoLinkAncestorSync(extended)).toThrow('symlink or junction')
  })
})

describe('the plugin makes no model calls, stores no keys, and phones nowhere', () => {
  const files: string[] = []
  const walk = (dir: string) => { for (const entry of readdirSync(dir)) { const path = join(dir, entry); if (statSync(path).isDirectory()) walk(path); else if (path.endsWith('.ts')) files.push(path) } }
  walk(join(process.cwd(), 'src'))
  /** Code only: block and line comments may legitimately mention what Ditto avoids. */
  const code = (file: string) => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('never imports a model client or reads provider credentials', () => {
    for (const file of files) {
      const source = code(file)
      expect(source, file).not.toMatch(/from '@deepseek-ai\/dsh-llm/)
      expect(source, file).not.toMatch(/ctx\.llm|\.llm\./)
      expect(source, file).not.toMatch(/api[_-]?key|OPENAI|DEEPSEEK_API|ANTHROPIC/i)
    }
  })

  it('opens no network connections except its own loopback review page', () => {
    for (const file of files) {
      const source = code(file)
      // Allowed: the loopback review server, and the Origin comparison string it builds from its own host header.
      expect(source, file).not.toMatch(/https?:\/\/(?!127\.0\.0\.1|localhost|\$\{host\})/)
      if (/createServer\(/.test(source)) expect(source, file).toMatch(/host: '127\.0\.0\.1'/)
      // fetch() exists only in the browser-side scripts of the review pages, which call their own loopback API.
      if (/fetch\(/.test(source)) expect(file).toMatch(/src[\\/]ui[\\/]/)
    }
  })
})
