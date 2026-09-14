# M0 驗證紀錄

驗證日期：2026-09-14。環境：Windows、Node.js 22.23.1、npm、DSH 公開套件 `0.1.5-rc.1`。

## 自動驗證

| 指令 | 結果 |
|---|---|
| `npm run build` | TypeScript 編譯通過 |
| `npm test` | 3 個測試檔、14 個測試全部通過 |
| `npm run smoke:dsh` | 真實 Cordis、ToolRuntime 與 SystemPrompt rc.1；五個工具皆註冊並實際 dispatch；guard 與 `tools/pre-execute` 拒絕時，apply 沒有寫入副作用 |
| `npm ls --all` | 指令成功；DSH 套件閉包固定在 `0.1.5-rc.1`。輸出中的未安裝項目皆為依平台／測試環境選裝的 optional dependencies |
| `npm pack --json --dry-run` | 成功；39 個套件項目，含 README、文件、manifest patch 與完整 `dist`；CLI 保留跨平台 shebang |

核心測試覆蓋預覽不寫入、來源 hash 新鮮度、重名與 Windows 大小寫衝突、路徑跳脫、symlink／junction 邊界、目的檔不覆寫、中斷後狀態與重跑、配方驗證。UI 測試會執行輸出的瀏覽器腳本，並檢查儲存成功或失敗後按鈕都恢復可操作。

## 真實瀏覽器流程

使用 `npm run demo` 建立 14 份合成文件，再於本機工作台完成：

1. 將 `工作紀錄.json` 的目的地改成 `其他\專案工作紀錄.json`。
2. 確認有未儲存修正時，建立副本按鈕停用；按「更新檢視」後 digest 改變並恢復可建立。
3. 儲存 `客戶資料整理示範` 配方，重新載入後逐檔修正仍存在。
4. 建立副本後，畫面顯示 14 個「已建立副本」與逐項結果。
5. 修正後另作回歸：儲存成功後「儲存做法」按鈕可再次操作。

## 實體檔案校驗

對已套用計畫 `61cd4fde-660d-4df4-9353-353284971d09` 逐項驗證：

- 來源檔案：14；輸出檔案：14；計畫狀態 applied：14。
- 每個來源目前 SHA-256 仍等於預覽時記錄的 hash。
- 每個輸出檔案 SHA-256 都等於對應來源；失敗數 0。
- 修正後的 `其他\專案工作紀錄.json` 確實存在。

## DSH 相容範圍

五個公開工具為 `ditto_preview`、`ditto_revise`、`ditto_apply`、`ditto_status`、`ditto_recipe`。工具說明包含使用時機、輸入來源、分頁、舊 revision／digest 與來源變動時的復原方式。digest 是審閱計畫的完整性識別，不是假裝成人類核准證明。

本輪 smoke 使用真實 Cordis 及已發布的 DSH rc.1 元件，但沒有啟動完整 `@deepseek-ai/dsh` CLI profile，也沒有呼叫模型。本機 Node 22 下，上游 rc.1 CLI bin 使用的 `import.meta.main` 入口不會可靠啟動；完整 profile 驗收應在 Node 24 環境進行，再決定是否安裝到日常 DSH。插件自己的檔案能力由設定的 workspace 邊界與核心檢查約束；這不能取代宿主的檔案 sandbox 權限模型。多程序同時操作同一 state root 仍不支援。

## 產品判斷

M0 已證明「預覽 → 修正 → 建立副本 → 保存做法」可以安全地跑完。它仍是固定規則加逐檔覆寫，沒有從修正樣本學會語意。M1 應先驗證兩個條件：建議名稱是否真的需要讀文件內容，以及同類批次是否會反覆出現；若任一條件不成立，停止擴大成通用產品。
