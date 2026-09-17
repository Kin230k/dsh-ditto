import type { StructuralFacts } from '../types.js'

/**
 * A language adapter tells discovery which files are modules and extracts
 * deterministic structural facts from source text. It never parses with a
 * compiler, never imports the module, and never executes anything.
 *
 * Evidence chunking, citation validation, rendering, and every safety gate are
 * language-independent, so a new language only needs this small surface.
 */
export interface LanguageAdapter {
  /** Stable identifier persisted with each module (for example `typescript`). */
  readonly id: string
  /** Human-readable name used in diagnostics and documentation. */
  readonly displayName: string
  /** Lower-case file extensions, including the dot, that this adapter claims. */
  readonly extensions: ReadonlySet<string>
  /**
   * Optional per-file exclusion for files that match an extension but are not
   * modules worth specifying, such as TypeScript declaration files. Returning a
   * reason excludes the file and counts it under that reason.
   */
  exclude?(fileName: string): 'declaration-file' | 'generated' | undefined
  /** Extract exported names, imported specifiers, and the line count from source text. */
  structuralFacts(text: string): StructuralFacts
}
