// Renders the headless demo transcript as a static SVG "terminal" for the README.
// Deterministic: same input, same SVG. Run: node scripts/render-demo-svg.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const lines = [
  ['prompt', '$ dsh-ditto demo --headless'],
  ['muted', 'Ditto demo — synthetic repository, deterministic generator, no model calls, no API key'],
  ['muted', 'Source  ./source     (16 TypeScript modules)'],
  ['muted', 'Output  ./specifications'],
  ['', ''],
  ['step', '1. Discover   16 modules in scope · 3 excluded: node_modules, README.md, src/types.d.ts'],
  ['step', '2. Samples    3 representative modules: src/index.ts, src/services/billing.ts, src/utils/format.ts'],
  ['step', '3. Review     edit the three samples until they look right (the headless demo accepts them)'],
  ['step', '4. Approve    recipe revision 2 · digest b87eddfc1269…'],
  ['warn', '5. Preview    16/16 specifications rendered · 1 needs confirmation: src/routes/webhooks.ts'],
  ['ok', '6. Apply      16/16 written · 0 failed · 0 source files modified (hashes re-verified)'],
  ['', ''],
  ['muted', 'Specifications: ./specifications'],
]

const width = 960
const lineHeight = 24
const padding = 20
const headerHeight = 36
const height = headerHeight + padding * 2 + lines.length * lineHeight
const colors = { bg: '#0f172a', text: '#e2e8f0', muted: '#94a3b8', prompt: '#f8fafc', step: '#cbd5e1', ok: '#4ade80', warn: '#fbbf24', chrome: '#1e293b' }
const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const body = lines.map(([kind, text], index) => {
  const y = headerHeight + padding + lineHeight * (index + 1) - 6
  const fill = colors[kind] ?? colors.text
  const weight = kind === 'ok' || kind === 'warn' || kind === 'prompt' ? ' font-weight="600"' : ''
  return `  <text x="${padding}" y="${y}" fill="${fill}"${weight}>${escape(text)}</text>`
}).join('\n')

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="14">
  <title>dsh-ditto demo --headless: discover 16 modules, review 3 samples, approve, preview everything, apply 16/16 with 0 source files modified</title>
  <rect width="${width}" height="${height}" rx="12" fill="${colors.bg}"/>
  <rect width="${width}" height="${headerHeight}" rx="12" fill="${colors.chrome}"/>
  <rect y="${headerHeight - 12}" width="${width}" height="12" fill="${colors.chrome}"/>
  <circle cx="20" cy="18" r="6" fill="#ef4444"/><circle cx="40" cy="18" r="6" fill="#f59e0b"/><circle cx="60" cy="18" r="6" fill="#22c55e"/>
  <text x="${width / 2}" y="23" fill="${colors.muted}" text-anchor="middle" font-size="12">Ditto — Review a few. Ditto the rest.</text>
${body}
</svg>
`
mkdirSync(join('docs', 'assets'), { recursive: true })
writeFileSync(join('docs', 'assets', 'demo.svg'), svg)
console.log('Wrote docs/assets/demo.svg')
