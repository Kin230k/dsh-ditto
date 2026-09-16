# DSH Ditto M0 與 M1 工作台

## M1 程式碼規格工作台

`startSpecWorkbench({ sourceRoot, outputRoot, stateRoot, generator })` 啟動另一個僅限 loopback 的 M1 頁面；M0 的 `startLocalWorkbench` 和既有端點保持不變。M1 先掃描 10–50 個 TypeScript/JavaScript 模組，呈現掃描範圍、排除數與有界的排除清單，並只生成三份結構不同的樣本。這三份 Markdown 和批次指示可以直接編輯；每次更新都會改變 review digest 並取消核准。只有核准全部樣本後，`POST /api/spec/generate` 才會生成其餘模組。

頁面使用下列同源、CSRF 保護的端點：

- `GET /api/spec/batch`：取得經過瀏覽器資料最小化的批次預覽。
- `POST /api/spec/revise`：提交三份樣本與批次指示；需要目前 revision。
- `POST /api/spec/approve`：以目前 revision/digest 核准三份樣本。
- `POST /api/spec/generate`：只在已核准時生成未處理模組。
- `POST /api/spec/apply`：以精確 id/revision/digest 寫入 Markdown，並回傳逐項磁碟結果。

每份規格都將 evidence id 顯示為來源相對路徑與行號的頁內連結；「待確認」模組另集中列出。完整預覽保留所有模組而不是只顯示三份樣本。預覽與生成不會寫來源或輸出目錄，只有 apply 可以建立輸出 Markdown。若使用 deterministic fake generator，啟動選項必須傳 `demo: true`，頁面會標示「合成／測試生成示範」；它不代表模型品質或真實自動化。

`renderWorkbench(plan, { csrfToken, apiBase })` 產生不依賴 CDN 的繁體中文本機工作台。它只呼叫同一個 loopback 服務的受限端點：

- `GET /api/plan` 取得目前的計畫。
- `POST /api/revise` 以目前 revision 和逐檔目的地更新預覽。
- `POST /api/apply` 以目前 revision 與 digest 建立實際副本。
- `GET /api/recipe`、`POST /api/recipe` 與 `POST /api/recipe/load` 列出、儲存及載入做法。

所有變更請求都帶 `X-DSH-CSRF`。使用者修改範例名稱後，工作台會停用建立副本按鈕，直到伺服器回傳新的計畫和 digest。

三份範例依計畫中的分類或副檔名作可重現的多樣化挑選，接著才依檔案順序補足；它們不是模型信心或語意代表性判斷。完整批次永遠顯示真實的來源與目的地。

M0 的復原界線是刻意保守的：一旦實際建立回報 `failed` 或 `rejected`，使用者必須建立新的預覽。特別是來源在預覽後改變時，絕不能以舊的核准計畫重新雜湊或直接重試。工作台會顯示每個項目的實際原因，並把需要處理的結果放在完整批次前方。
