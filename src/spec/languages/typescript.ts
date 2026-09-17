import type { StructuralFacts } from '../types.js'
import type { LanguageAdapter } from './types.js'

const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'])

/** Regex-based facts for TypeScript and JavaScript modules. Approximate by design: facts are hints for sample selection and the model, never claims. */
export function typescriptFacts(text: string): StructuralFacts {
  const exports = new Set<string>(); const imports = new Set<string>()
  for (const match of text.matchAll(/\bexport\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/g)) exports.add(match[1]!)
  for (const match of text.matchAll(/\bexport\s*\{([^}]+)\}/g)) for (const part of match[1]!.split(',')) { const name = part.trim().split(/\s+as\s+/).pop()?.trim(); if (name) exports.add(name) }
  for (const match of text.matchAll(/\b(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g)) imports.add(match[1]!)
  for (const match of text.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) imports.add(match[1]!)
  return { exports: [...exports].filter(Boolean).sort(), imports: [...imports].sort(), lineCount: text.replace(/\r\n/g, '\n').split('\n').length }
}

export const typescript: LanguageAdapter = {
  id: 'typescript',
  displayName: 'TypeScript / JavaScript',
  extensions: EXTENSIONS,
  exclude: fileName => /\.d\.[cm]?ts$/i.test(fileName) ? 'declaration-file' : undefined,
  structuralFacts: typescriptFacts,
}
