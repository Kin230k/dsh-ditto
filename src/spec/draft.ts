import { hash } from './prepare.js'
import type { CitedText, Confirmation, PublicApiFact, SpecDraft, SpecModule } from './types.js'

const MAX_TEXT = 2_000
const MAX_LIST = 80
/** Shared with DSH's bounded few-shot boundary; samples are rejected, never silently truncated. */
export const MAX_REVIEWED_SAMPLE_MARKDOWN = 12_000

/** Rejects a model response before any preview or disk write. */
export function validateSpecDraft(draft: unknown, module: Pick<SpecModule, 'id' | 'relativePath' | 'evidence'>): asserts draft is SpecDraft {
  if (!draft || typeof draft !== 'object') throw new Error('規格草稿必須是 JSON 物件')
  const value = draft as Partial<SpecDraft>
  if (value.version !== 1 || value.moduleId !== module.id) throw new Error('規格草稿沒有對應到目前模組')
  const allowed = new Set(['version', 'moduleId', 'title', 'purpose', 'responsibilities', 'publicApi', 'dependencies', 'errors', 'confirmations'])
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('規格草稿包含不支援欄位')
  const known = new Set(module.evidence.map(chunk => chunk.id))
  cited(value.title, known, 'title'); cited(value.purpose, known, 'purpose')
  citedList(value.responsibilities, known, 'responsibilities')
  citedList(value.dependencies, known, 'dependencies'); citedList(value.errors, known, 'errors'); confirmations(value.confirmations, known)
  if (value.publicApi !== undefined) {
    if (!Array.isArray(value.publicApi) || value.publicApi.length > MAX_LIST) throw new Error('publicApi 不正確')
    for (const item of value.publicApi) publicApi(item, known)
  }
  if (!value.title && !value.purpose && !value.responsibilities?.length && !value.publicApi?.length && !value.dependencies?.length && !value.errors?.length && !value.confirmations?.length) throw new Error('規格草稿不可完全空白')
}

/** The renderer is deterministic. Generator-provided Markdown is never used as a write path or template. */
export function renderSpecDraft(draft: SpecDraft, module: Pick<SpecModule, 'relativePath' | 'evidence'>): string {
  validateSpecDraft(draft, { id: draft.moduleId, relativePath: module.relativePath, evidence: module.evidence })
  const title = draft.title ? `${draft.title.text} ${citations(draft.title)}` : `${module.relativePath} [${module.evidence[0].id}]`
  const lines: string[] = [`# ${title}`, '', `- 來源：\`${module.relativePath}\``, '']
  if (draft.purpose) section(lines, '用途', [draft.purpose])
  if (draft.responsibilities?.length) section(lines, '職責', draft.responsibilities)
  if (draft.publicApi?.length) {
    lines.push('## 公開 API', '')
    for (const item of draft.publicApi) lines.push(`- **${item.kind} ${item.name}**${item.parameters?.length ? `（${item.parameters.join(', ')}）` : ''}：${item.text} ${citations(item)}`)
    lines.push('')
  }
  if (draft.dependencies?.length) section(lines, '相依項目', draft.dependencies)
  if (draft.errors?.length) section(lines, '可觀察到的錯誤或邊界情況', draft.errors)
  if (draft.confirmations?.length) confirmationSection(lines, draft.confirmations)
  lines.push('## 證據', '')
  const used = usedCitations(draft); for (const id of [...used].sort()) { const evidence = module.evidence.find(chunk => chunk.id === id)!; lines.push(`- ${id}：\`${evidence.relativePath}:${evidence.startLine}-${evidence.endLine}\``) }
  return `${lines.join('\n').trimEnd()}\n`
}

/** Manual sample Markdown must retain real evidence citations on each factual line. */
export function validateReviewedMarkdown(markdown: unknown, module: Pick<SpecModule, 'evidence'>): asserts markdown is string {
  if (typeof markdown !== 'string' || markdown.length < 1 || markdown.length > MAX_REVIEWED_SAMPLE_MARKDOWN || markdown.includes('\u0000')) throw new Error(`樣本 Markdown 必須介於 1 到 ${MAX_REVIEWED_SAMPLE_MARKDOWN} 個字元`)
  const known = new Set(module.evidence.map(chunk => chunk.id)); const citedIds = new Set<string>()
  for (const id of markdown.matchAll(/\[(ev_[a-f0-9]{24})\]/g)) { if (!known.has(id[1])) throw new Error(`樣本引用了不存在的證據：${id[1]}`); citedIds.add(id[1]) }
  if (!citedIds.size) throw new Error('樣本 Markdown 必須保留至少一個證據引用')
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  for (const line of lines) {
    const fact = line.trim()
    if (!fact || /^##{1,6}\s/.test(fact) || /^[-*]\s+(來源|證據)：/.test(fact) || /^[-*]\s+ev_[a-f0-9]{24}：/.test(fact)) continue
    if (/^[-*]\s+待確認：/.test(fact) && /[？?]$/.test(fact.replace(/\s*\[ev_[a-f0-9]{24}\]/g, '').trim())) continue
    if (!/\[ev_[a-f0-9]{24}\]/.test(fact)) throw new Error('樣本中的每一項事實都必須附有證據引用')
  }
}

export function renderedHash(markdown: string): string { return hash(markdown) }

function section(lines: string[], heading: string, values: CitedText[]): void {
  lines.push(`## ${heading}`, '')
  for (const value of values) lines.push(`- ${value.text} ${citations(value)}`)
  lines.push('')
}
function citations(value: CitedText): string { return value.citations.map(id => `[${id}]`).join(' ') }
function usedCitations(draft: SpecDraft): Set<string> {
  const used = new Set<string>(); const add = (fact?: CitedText) => fact?.citations.forEach(id => used.add(id))
  add(draft.title); add(draft.purpose); for (const value of draft.responsibilities ?? []) add(value); for (const value of draft.publicApi ?? []) add(value); for (const value of draft.dependencies ?? []) add(value); for (const value of draft.errors ?? []) add(value); for (const value of draft.confirmations ?? []) value.relatedEvidenceIds?.forEach(id => used.add(id))
  return used
}
function cited(value: unknown, known: Set<string>, name: string): void {
  if (value === undefined) return
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} 不正確`)
  const fact = value as CitedText
  if (typeof fact.text !== 'string' || fact.text.trim().length === 0 || fact.text.length > MAX_TEXT || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(fact.text)) throw new Error(`${name} 文字不正確`)
  if (!Array.isArray(fact.citations) || fact.citations.length < 1 || fact.citations.length > 12 || fact.citations.some(id => typeof id !== 'string' || !known.has(id)) || new Set(fact.citations).size !== fact.citations.length) throw new Error(`${name} 必須引用目前來源的證據`)
  if (Object.keys(fact).some(key => key !== 'text' && key !== 'citations' && key !== 'kind' && key !== 'name' && key !== 'parameters')) throw new Error(`${name} 包含不支援欄位`)
}
function citedList(value: unknown, known: Set<string>, name: string): void { if (value === undefined) return; if (!Array.isArray(value) || value.length > MAX_LIST) throw new Error(`${name} 不正確`); for (const fact of value) cited(fact, known, name) }
function confirmations(value: unknown, known: Set<string>): void {
  if (value === undefined) return
  if (!Array.isArray(value) || value.length > MAX_LIST) throw new Error('confirmations 不正確')
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('待確認項目不正確')
    const confirmation = item as Confirmation
    if (typeof confirmation.question !== 'string' || confirmation.question.trim().length < 2 || confirmation.question.length > MAX_TEXT || !/[？?]\s*$/.test(confirmation.question) || Object.keys(confirmation).some(key => key !== 'question' && key !== 'relatedEvidenceIds')) throw new Error('待確認項目必須是問題')
    if (confirmation.relatedEvidenceIds !== undefined && (!Array.isArray(confirmation.relatedEvidenceIds) || confirmation.relatedEvidenceIds.length > 12 || confirmation.relatedEvidenceIds.some(id => typeof id !== 'string' || !known.has(id)) || new Set(confirmation.relatedEvidenceIds).size !== confirmation.relatedEvidenceIds.length)) throw new Error('待確認項目的相關證據不正確')
  }
}
function confirmationSection(lines: string[], values: Confirmation[]): void { lines.push('## 待確認', ''); for (const value of values) lines.push(`- 待確認：${value.question}${value.relatedEvidenceIds?.length ? ` ${value.relatedEvidenceIds.map(id => `[${id}]`).join(' ')}` : ''}`); lines.push('') }
function publicApi(value: unknown, known: Set<string>): void {
  cited(value, known, 'publicApi'); const fact = value as PublicApiFact
  if (!['function', 'class', 'type', 'value'].includes(fact.kind) || typeof fact.name !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(fact.name) || (fact.parameters !== undefined && (!Array.isArray(fact.parameters) || fact.parameters.length > 30 || fact.parameters.some(parameter => typeof parameter !== 'string' || parameter.length > 200)))) throw new Error('publicApi 不正確')
}
