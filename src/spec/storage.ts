import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { assertSpecBatch } from './generate.js'
import type { SpecBatch } from './types.js'

const BATCHES = 'spec-batches'

export async function saveSpecBatch(batch: SpecBatch, stateRoot: string): Promise<void> { assertSpecBatch(batch); await atomicJson(specStateFile(stateRoot, BATCHES, batch.id), batch) }
export async function loadSpecBatch(batchId: string, stateRoot: string): Promise<SpecBatch> {
  if (!/^[0-9a-f-]{16,64}$/i.test(batchId)) throw new Error('規格批次 ID 不正確')
  let parsed: unknown; try { parsed = JSON.parse(await readFile(specStateFile(stateRoot, BATCHES, batchId), 'utf8')) } catch (error: unknown) { if (error instanceof SyntaxError) throw new Error('儲存的規格批次不是 JSON'); throw error }
  assertSpecBatch(parsed); return parsed
}

function specStateFile(stateRoot: string, category: string, id: string): string { const root = resolve(stateRoot); const file = resolve(root, category, `${id}.json`); if (!file.startsWith(`${root}\\`) && !file.startsWith(`${root}/`)) throw new Error('狀態資料夾不正確'); return file }
async function atomicJson(file: string, value: unknown): Promise<void> { await mkdir(dirname(file), { recursive: true }); const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }); await rename(temporary, file) }
