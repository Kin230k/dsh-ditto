import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const require = createRequire(import.meta.url)
const EXPECTED = '0.1.5-rc.1'

async function main(): Promise<void> {
  assertVersion('@deepseek-ai/dsh-tools')
  assertVersion('@deepseek-ai/dsh-system-prompt')
  const dshHome = await mkdtemp(join(tmpdir(), 'dsh-ditto-component-home-'))
  try {
    console.log(`DSH Ditto component-host smoke: ToolRuntime ${EXPECTED}, SystemPrompt ${EXPECTED}`)
    console.log(`Isolated DSH_HOME: ${dshHome}`)
    await run(process.execPath, [require.resolve('vitest/vitest.mjs'), 'run', 'tests/dsh/native-tools.spec.ts'], { ...process.env, DSH_HOME: dshHome })
    console.log('Passed: real Cordis + published ToolRuntime registered and dispatched all five native tools; pre-execute and guard denial prevented ditto_apply side effects.')
    console.log('Scope: component-host smoke only. It does not boot an @deepseek-ai/dsh CLI profile or make a model call.')
  } finally {
    await rm(dshHome, { recursive: true, force: true })
  }
}

function assertVersion(packageName: string): void {
  const packageJson = require(`${packageName}/package.json`) as { version?: unknown }
  if (packageJson.version !== EXPECTED) throw new Error(`${packageName} must resolve to ${EXPECTED}, got ${String(packageJson.version)}`)
}

async function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: process.cwd(), env, stdio: 'inherit', windowsHide: true })
    child.once('error', rejectRun)
    child.once('exit', code => code === 0 ? resolveRun() : rejectRun(new Error(`Smoke command exited ${String(code)}`)))
  })
}

void main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
