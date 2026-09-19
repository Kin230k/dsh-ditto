import { atomicWriteStateText, readStateText } from '../core/state-paths.js'
import { assertSpecBatch } from './generate.js'
import type { SpecBatch } from './types.js'

const BATCHES = 'spec-batches'

export async function saveSpecBatch(batch: SpecBatch, stateRoot: string): Promise<void> {
  assertSpecBatch(batch)
  await atomicWriteStateText(stateRoot, BATCHES, `${batch.id}.json`, `${JSON.stringify(batch, null, 2)}\n`)
}

export async function loadSpecBatch(batchId: string, stateRoot: string): Promise<SpecBatch> {
  if (!/^[0-9a-f-]{16,64}$/i.test(batchId)) throw new Error('Invalid specification batch id')
  let parsed: unknown
  try { parsed = JSON.parse(await readStateText(stateRoot, BATCHES, `${batchId}.json`)) } catch (error: unknown) {
    if (error instanceof SyntaxError) throw new Error('The saved specification batch is not valid JSON')
    throw error
  }
  assertSpecBatch(parsed)
  return parsed
}
