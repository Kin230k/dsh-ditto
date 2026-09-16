# DSH Ditto｜照樣做

**先做幾份給你看，改到滿意，其餘照樣做。**

Ditto 是給一般使用者的 DSH 批次工作台。M0 可把雜亂文件複製到命名一致、分類清楚的新資料夾，原文件保留。M1 可把 TypeScript／JavaScript 程式庫中的 10–50 個模組，批量產出可追溯的 Markdown 規格。

M0「整理預覽版」提供宣告式命名規則、三份分散抽樣、整批預覽、逐檔修正、真實副本輸出、逐項狀態與配方保存。M1「程式碼轉規格」提供來源掃描、三份可編輯規格樣本、明確核准、完整預覽，以及寫入獨立輸出資料夾。兩個流程都保留來源檔案。

這個新專案獨立於 KeepGate，也沒有修改本機既有 DSH。目標相容性測試使用 `0.1.5-rc.1` 的公開套件；相容性需以實際 smoke 結果為準。

## 核心用途：批量把程式碼變成規格

比起單純整理檔名，Ditto 更有價值的用途是用同一套要求，批量把程式碼轉成可驗證的規格。

> 給 Ditto 一個你認可的規格範例，它會依照這個標準處理整個程式庫。

目前可用流程：

1. 掃描專案中的 API、service 與資料模型。
2. 選出三個不同類型的模組，先產生規格範例。
3. 使用者直接修改範例，決定格式、深度與用詞。
4. 先明確核准三份樣本；修改樣本或指示後，系統會撤銷舊核准。
5. Ditto 把核准樣本當作本批的範例，生成其餘模組並顯示完整預覽。
6. 來源 hash、證據引用與輸出路徑通過檢查後，才寫入新的規格資料夾；每個模組保留成功、待確認或失敗結果。

產出的每項敘述都應附上來源位置。無法由程式碼證明的內容必須標成「待確認」，不能自行補完：

```markdown
## POST /orders

用途：建立訂單

輸入：
- customerId: string，必填
- items: OrderItem[]，至少一筆

錯誤：
- 400：輸入資料不完整
- 409：訂單識別碼重複

來源：
- src/routes/orders.ts:42
- src/services/order-service.ts:18
- src/models/order.ts:7
```

直接請 AI 處理一個檔案很方便；當專案有數十個模組時，使用者卻要反覆貼程式碼、重講格式、檢查遺漏並整理輸出。Ditto 的優勢是先用少數範例校準要求，再以一致標準處理整批內容，於套用前展示完整預覽，最後回報每個項目的真實結果。第一批候選用途包括：

- 程式碼 → API 規格
- 程式碼 → 模組說明
- 程式碼 → 測試案例清單
- 多個相似模組 → 統一格式的技術文件
- 舊系統 → 重構前行為規格

優先驗證 **整個程式庫 → 批量規格產出**。成功標準是處理 10–50 個模組時，比逐個交給 AI 節省至少一半的人工作業時間，同時維持格式一致、來源可追溯，且沒有漏掉任何項目。M1 已完成可操作的工程原型；真實模型輸出品質與使用者節省時間仍待用真實程式庫量測。

- [產品路線圖](docs/ROADMAP.zh-TW.md)：使用者、階段、驗收指標與停止條件。
- [實作狀態](docs/IMPLEMENTATION-STATUS.zh-TW.md)：GPT-5.6 Terra 工作包與交付紀錄。
- [驗證紀錄](docs/VALIDATION.zh-TW.md)：測試、真實檔案副本與 DSH 相容範圍。
- [競品與選擇依據](docs/research/COMPETITORS.zh-TW.md)：為何選擇樣本先行的批次工作。
- [DSH 版本差異](docs/research/UPSTREAM.zh-TW.md)：本機 rc.5 與新版的差異。
- [KeepGate 經驗](docs/research/KEEPGATE-LESSONS.zh-TW.md)：保留可追溯與真實結果，降低治理負擔。

## 本機試用

需要 Node.js 22 以上與 npm。以下指令只會在專案忽略的 `.local` 目錄建立合成資料：

```powershell
cd C:\Users\user\Desktop\dsh-ditto
npm install
npm run build
npm run demo
```

終端會印出一次性的 loopback 網址。開啟後可修改目的地、更新檢視、建立副本、儲存及載入做法。若要使用自己的資料，請指定新的輸出與狀態資料夾：

```powershell
npx tsx src/cli.ts serve <來源資料夾> <新的輸出資料夾> <本機狀態資料夾>
```

程式碼轉規格流程可用以下合成資料驗收。此命令使用明確標示的固定示範生成器，只用來檢查流程與安全閘門，不代表模型品質：

```powershell
npm run demo:spec
```

在實際 DSH 工作階段中，agent 依序使用 `ditto_spec_create`、`ditto_spec_queue`、`ditto_spec_module`、`ditto_spec_submit`、`ditto_spec_review`、`ditto_spec_revise_samples`、`ditto_spec_approve`、`ditto_spec_apply` 與 `ditto_spec_status` 工具。工具本身不直接持有模型金鑰；DSH agent 在正常模型對話流程中讀取證據、提出結構化草稿。

驗證指令：

```powershell
npm test
npm run smoke:dsh
```

目前尚未發布 npm 套件、安裝進使用者日常 DSH profile 或完成市場驗證。公開發行前仍需在 Node 24 以完整 DSH CLI profile 驗收、以真實程式庫和模型量測結果，並選定授權條款。
