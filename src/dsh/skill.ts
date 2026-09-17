import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'

/**
 * `skills/ditto/SKILL.md` is the single source of truth for the Ditto skill.
 * It uses the same frontmatter the DSH filesystem skill provider accepts, so a
 * human can review it in the repository and the plugin registers exactly that
 * file at runtime. Nothing here is duplicated in TypeScript.
 */
export const SKILL_FILE = fileURLToPath(new URL('../../skills/ditto/SKILL.md', import.meta.url))

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const BOOLEAN_FIELDS = ['disable-model-invocation', 'user-invocable'] as const

export interface ParsedSkillFile {
  readonly frontmatter: Readonly<Record<string, string | boolean>>
  readonly content: string
}

/** Parse a SKILL.md file: a flat YAML frontmatter block (string and boolean scalars only) followed by the Markdown body. */
export function parseSkillFile(source: string): ParsedSkillFile {
  const text = source.replace(/\r\n/g, '\n')
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  if (!match) throw new Error('SKILL.md must start with a YAML frontmatter block')
  const frontmatter: Record<string, string | boolean> = {}
  for (const rawLine of match[1]!.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf(':')
    if (separator <= 0) throw new Error(`Unsupported frontmatter line: ${line}`)
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    if (!/^[a-zA-Z][\w-]*$/.test(key)) throw new Error(`Unsupported frontmatter key: ${key}`)
    frontmatter[key] = parseScalar(key, value)
  }
  return { frontmatter, content: match[2]!.trim() }
}

/** The registration handed to `ctx.skills.register()`. Exported so tests and documentation can compare it with the file. */
export function dittoSkill(file: string = SKILL_FILE): SkillRegistration {
  const parsed = parseSkillFile(readFileSync(file, 'utf8'))
  const { name, description, whenToUse } = parsed.frontmatter
  if (typeof name !== 'string' || !SKILL_NAME.test(name)) throw new Error('SKILL.md frontmatter needs a kebab-case name')
  if (typeof description !== 'string' || description.length < 1 || description.length > 1_024) throw new Error('SKILL.md frontmatter needs a description (1–1024 characters)')
  if (whenToUse !== undefined && typeof whenToUse !== 'string') throw new Error('SKILL.md whenToUse must be a string')
  if (parsed.content.length < 1) throw new Error('SKILL.md body is empty')
  const modelInvocable = parsed.frontmatter['disable-model-invocation'] !== true
  const userInvocable = parsed.frontmatter['user-invocable'] !== false
  return {
    name,
    description,
    ...(whenToUse ? { whenToUse } : {}),
    source: 'bundled',
    invocation: { modelInvocable, userInvocable },
    content: parsed.content,
    path: file,
    resourceBase: { kind: 'directory', path: dirname(file) },
  }
}

function parseScalar(key: string, value: string): string | boolean {
  if ((BOOLEAN_FIELDS as readonly string[]).includes(key)) {
    if (/^(true|yes|on|1)$/i.test(value)) return true
    if (/^(false|no|off|0)$/i.test(value)) return false
    throw new Error(`SKILL.md frontmatter field "${key}" must be a boolean`)
  }
  if (/^".*"$/.test(value)) return JSON.parse(value) as string
  if (/^'.*'$/.test(value)) return value.slice(1, -1).replace(/''/g, "'")
  return value
}
