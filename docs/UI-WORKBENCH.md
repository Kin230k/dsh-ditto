# DSH Ditto M0 工作台

`renderWorkbench(plan, { csrfToken, apiBase })` 產生不依賴 CDN 的繁體中文本機工作台。它只呼叫同一個 loopback 服務的受限端點：

- `GET /api/plan` 取得目前的計畫。
- `POST /api/revise` 以目前 revision 和逐檔目的地更新預覽。
- `POST /api/apply` 以目前 revision 與 digest 建立實際副本。
- `GET /api/recipe`、`POST /api/recipe` 與 `POST /api/recipe/load` 列出、儲存及載入做法。

所有變更請求都帶 `X-DSH-CSRF`。使用者修改範例名稱後，工作台會停用建立副本按鈕，直到伺服器回傳新的計畫和 digest。

三份範例依計畫中的分類或副檔名作可重現的多樣化挑選，接著才依檔案順序補足；它們不是模型信心或語意代表性判斷。完整批次永遠顯示真實的來源與目的地。

M0 的復原界線是刻意保守的：一旦實際建立回報 `failed` 或 `rejected`，使用者必須建立新的預覽。特別是來源在預覽後改變時，絕不能以舊的核准計畫重新雜湊或直接重試。工作台會顯示每個項目的實際原因，並把需要處理的結果放在完整批次前方。
