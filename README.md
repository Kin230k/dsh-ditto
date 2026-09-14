# DSH Ditto｜照樣做

**先做幾份給你看，改到滿意，其餘照樣做。**

Ditto 是給一般使用者的 DSH 批次文件工作台。第一個用途是把雜亂文件整理成命名一致、分類清楚的新資料夾，原文件保留。

M0「整理預覽版」已可操作：宣告式命名規則、三份分散抽樣、整批預覽、逐檔修正、真實副本輸出、逐項狀態與配方保存。完整的「使用者修正樣本 → AI 推測配方 → 套用其他文件」屬於 M1，尚未宣稱實現。

這個新專案獨立於 KeepGate，也沒有修改本機既有 DSH。目標相容性測試使用 `0.1.5-rc.1` 的公開套件；相容性需以實際 smoke 結果為準。

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

驗證指令：

```powershell
npm test
npm run smoke:dsh
```

目前尚未發布 npm 套件、安裝進使用者日常 DSH profile 或完成市場驗證。
