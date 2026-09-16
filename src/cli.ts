#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPlan, defaultRecipe } from './core/index.js'
import type { SpecGenerator } from './spec/types.js'
import { startLocalWorkbench, startSpecWorkbench } from './server.js'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function main(): Promise<void> {
  const [command, sourceArgument, destinationArgument, stateArgument] = process.argv.slice(2)
  if (command === 'demo') return await runDemo()
  if (command === 'demo-spec') return await runSpecDemo()
  if (command === 'serve' && sourceArgument && destinationArgument && stateArgument) return await serve(resolve(sourceArgument), resolve(destinationArgument), resolve(stateArgument))
  console.error('用法：\n  dsh-ditto demo\n  dsh-ditto demo-spec\n  dsh-ditto serve <來源資料夾> <新的輸出資料夾> <本機狀態資料夾>')
  process.exitCode = 2
}

/** A labelled local-only M1 demo. Its deterministic generator is never presented as a model provider. */
async function runSpecDemo(): Promise<void> {
  const runRoot = join(projectRoot, '.local', 'spec-demo-runs', randomUUID())
  const sourceRoot = join(runRoot, 'source'); const outputRoot = join(runRoot, 'specifications'); const stateRoot = join(runRoot, 'state')
  const fixtures = Array.from({ length: 12 }, (_, index) => {
    const number = index + 1
    const content = index % 3 === 0 ? `import { normalize } from './shared.js'\nexport function task${number}(value: string) { return normalize(value) }\n` : index % 3 === 1 ? `export class Task${number} { readonly id = '${number}' }\n` : `export type Task${number} = { id: string; enabled: boolean }\n`
    return [`src/task-${number}.ts`, content] as const
  })
  await Promise.all(fixtures.map(async ([relativePath, contents]) => { const file = join(sourceRoot, ...relativePath.split('/')); await mkdir(dirname(file), { recursive: true }); await writeFile(file, contents, 'utf8') }))
  const generator: SpecGenerator = {
    id: 'deterministic-demo-generator',
    async generate({ module }) {
      const evidence = module.evidence[0]
      return { metadata: { generator: 'deterministic-demo', label: 'synthetic-test-demo-only' }, draft: { version: 1, moduleId: module.id, title: { text: `${module.relativePath} 規格`, citations: [evidence.id] }, purpose: { text: '這是合成示範產生的規格草稿；請以來源證據確認。', citations: [evidence.id] }, confirmations: [{ question: '這個模組的實際呼叫端是否仍需要人工確認？', relatedEvidenceIds: [evidence.id] }] } }
    },
  }
  const workbench = await startSpecWorkbench({ sourceRoot, outputRoot, stateRoot, generator, demo: true })
  console.log(`DSH Ditto M1 合成／測試生成示範（deterministic fake generator，非模型）：${runRoot}`)
  console.log(`來源：${sourceRoot}\n規格輸出：${outputRoot}`)
  console.log(`請在瀏覽器開啟：${workbench.url}`)
  console.log('先核准三份樣本，再生成完整批次；按下寫入前不會建立規格檔。')
  await new Promise<void>(resolveStop => process.once('SIGINT', resolveStop))
  await workbench.close()
}

async function runDemo(): Promise<void> {
  const runRoot = join(projectRoot, '.local', 'demo-runs', randomUUID())
  const sourceRoot = join(runRoot, 'source')
  const destinationRoot = join(runRoot, 'organized-copies')
  const stateRoot = join(runRoot, 'state')
  await mkdir(join(sourceRoot, '收件匣'), { recursive: true })
  const fixtures: Array<[string, string]> = [
    ['收件匣/客戶清單.csv', '客戶名稱,聯絡人\n北極星,林小姐\n'], ['收件匣/報價草稿.md', '# 報價草稿\n\n合成示範資料。\n'],
    ['收件匣/交付檢查表.txt', '合成示範：交付前確認。\n'], ['會議筆記.txt', '2026-09-14 討論摘要\n'],
    ['專案簡報.md', '# 專案簡報\n\n這是本機合成示範。\n'], ['預算.csv', '項目,金額\n設計,12000\n'],
    ['工作紀錄.json', '{"demo":true,"note":"synthetic fixture"}\n'], ['訪談摘要.md', '# 訪談摘要\n\n使用者需求整理。\n'],
    ['待辦事項.txt', '確認時間\n寄送資料\n'], ['產品目錄.csv', '代號,名稱\nA-01,示範品\n'],
    ['研究備忘.md', '# 研究備忘\n\n僅供本機測試。\n'], ['聯絡資訊.csv', '姓名,電話\n王小明,00000000\n'],
    ['版本說明.txt', '版本 0.1.0 synthetic demo\n'], ['讀我.md', '# 讀我\n\n這些檔案由 demo 指令建立。\n'],
  ]
  await Promise.all(fixtures.map(async ([relativePath, contents]) => {
    const path = join(sourceRoot, ...relativePath.split('/')); await mkdir(dirname(path), { recursive: true }); await writeFile(path, contents, 'utf8')
  }))
  console.log(`DSH Ditto M0 合成示範資料夾：${runRoot}`)
  console.log(`來源：${sourceRoot}`)
  console.log(`輸出：${destinationRoot}`)
  return await serve(sourceRoot, destinationRoot, stateRoot, defaultRecipe('Demo：依類型分類'))
}

async function serve(sourceRoot: string, destinationRoot: string, stateRoot: string, recipe = defaultRecipe()): Promise<void> {
  const plan = await createPlan({ sourceRoot, destinationRoot, recipe, excludedRoots: [stateRoot] })
  const workbench = await startLocalWorkbench({ sourceRoot, destinationRoot, stateRoot, plan })
  console.log('本機預覽已準備完成。按下頁面中的「建立整理後的副本」才會寫入新的輸出資料夾。')
  console.log(`請在瀏覽器開啟：${workbench.url}`)
  console.log('按 Ctrl+C 可結束本機服務。')
  await new Promise<void>(resolveStop => process.once('SIGINT', resolveStop))
  await workbench.close()
}

void main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
