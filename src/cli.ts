#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPlan, defaultRecipe } from './core/index.js'
import { startLocalWorkbench } from './server.js'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function main(): Promise<void> {
  const [command, sourceArgument, destinationArgument, stateArgument] = process.argv.slice(2)
  if (command === 'demo') return await runDemo()
  if (command === 'serve' && sourceArgument && destinationArgument && stateArgument) return await serve(resolve(sourceArgument), resolve(destinationArgument), resolve(stateArgument))
  console.error('用法：\n  dsh-ditto demo\n  dsh-ditto serve <來源資料夾> <新的輸出資料夾> <本機狀態資料夾>')
  process.exitCode = 2
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
