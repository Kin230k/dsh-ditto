import { describe, expect, it } from 'vitest'
import { renderSidecarContent, validateSidecar } from '../../src/core/artifacts.js'
import type { PlanItem, SidecarSpec } from '../../src/core/types.js'

function item(relativePath: string, overrides: Partial<PlanItem> = {}): PlanItem {
  return {
    id: '0123456789abcdef', source: `/source/${relativePath}`, relativePath,
    destination: `out/${relativePath}`, sourceHash: 'a'.repeat(64), classification: 'text',
    proposalDisposition: 'ready', status: 'ready', ...overrides,
  }
}

function context(items: PlanItem[]) {
  return { planId: '11111111-1111-4111-8111-111111111111', revision: 2, sourceRoot: '/source', destinationRoot: '/output', items }
}

describe('reviewed sidecar renderers', () => {
  it('neutralises every spreadsheet formula prefix and includes exceptions in the complete manifest', () => {
    const items = ['=x.txt', '+x.txt', '-x.txt', '@x.txt', '\tx.txt', '\rx.txt'].map(name => item(name))
    items.push(item('unmatched.txt', { destination: '', proposalDisposition: 'exception', exceptionCode: 'unmatched', exceptionDetails: 'No match' }))
    const spec = { kind: 'manifest', destination: 'review.csv', format: 'csv' } as const
    const rendered = renderSidecarContent(spec, context(items))
    expect(rendered.split('\n')).toHaveLength(items.length + 2)
    for (const name of ['=x.txt', '+x.txt', '-x.txt', '@x.txt', '\tx.txt', '\rx.txt']) expect(rendered).toContain(`"'${name}`)
    expect(rendered).toContain('"exception","exception","unmatched","No match"')
    expect(renderSidecarContent(spec, context(items))).toBe(rendered)
  })

  it('escapes Markdown metacharacters as inert table data', () => {
    const spec = { kind: 'manifest', destination: 'review.md', format: 'markdown' } as const
    const rendered = renderSidecarContent(spec, context([item('a|b_[x]<y>&.txt')]))
    expect(rendered).toContain('a\\|b\\_\\[x\\]\\<y\\>\\&.txt')
    expect(rendered).not.toContain('| a|b_')
  })

  it.each([
    ['sqlserver', '[dbo].[FILES]', "N'O''Brien 世界'"],
    ['postgres', '"dbo"."FILES"', "'O''Brien 世界'"],
    ['sqlite', '"dbo"."FILES"', "'O''Brien 世界'"],
  ] as const)('renders escaped Unicode literals for %s without raw expressions', (dialect, qualified, literal) => {
    const spec: SidecarSpec = {
      kind: 'sql-insert', destination: `${dialect}.sql`,
      sql: { dialect, schema: 'dbo', table: 'FILES', columns: ['CODE'], values: { CODE: '{match.code}' } },
    }
    const rendered = renderSidecarContent(spec, context([item('report.txt', { captures: { code: "O'Brien 世界" } })]))
    expect(rendered).toBe(`INSERT INTO ${qualified} (${dialect === 'sqlserver' ? '[CODE]' : '"CODE"'}) VALUES (${literal});\n`)
    expect(rendered).not.toMatch(/--|\/\*|\bDROP\b/i)
  })

  it('requires exactly one safe template for every SQL column', () => {
    expect(() => validateSidecar({
      kind: 'sql-insert', destination: 'bad.sql',
      sql: { dialect: 'postgres', schema: 'public', table: 'files', columns: ['A', 'B'], values: { A: 'x' } },
    })).toThrow('exactly one template')
  })
})
