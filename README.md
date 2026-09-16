# DSH Ditto｜照樣做

[English](README.en.md) · [繁體中文](README.md)

> **先把三份做成你要的樣子，再把整個程式庫照樣做好。**

DSH Ditto 把「逐檔和 AI 討論」變成可審查的批次工作。它先從 TypeScript／JavaScript 程式庫挑出三個結構不同的模組，讓你直接修改規格範例；你核准後，Ditto 用同一套寫法完成其餘模組，並把每個敘述連回原始碼行號。

適合需要把 10–50 個模組變成一致 API 文件、模組說明、測試案例清單或重構前行為規格的團隊。

## 為什麼不直接把程式碼丟給 AI？

單一檔案交給 AI 很快。模組一多，格式要求、術語、核對與漏檔檢查就得重複做。Ditto 把這些工作集中成一個可見流程：

1. **三份樣本定標準**：直接改 Markdown，不必寫長 prompt。
2. **整批預覽找例外**：所有模組都有狀態與輸出路徑，不靠猜測是否漏掉。
3. **證據連回原始碼**：每個事實都引用實際檔案與行號；無法證明的內容列為「待確認」。
4. **先檢查，再寫入**：來源檔不執行、不修改；文件只寫進新的輸出資料夾。

```text
掃描程式庫 → 三份規格樣本 → 你修改並核准 → 完整批次預覽 → 寫入 Markdown
```

## 你會得到什麼

- 同一種寫法的 API 與模組規格
- 每份規格的來源證據與輸出結果
- 集中處理的待確認項目，而不是模型補出的答案
- 可中斷、可續跑的批次狀態

目前的 M1 原型支援 TypeScript／JavaScript，並保留 M0 的非破壞式文件整理流程。

## 60 秒試用

需要 Node.js 22 以上與 npm。

```powershell
cd C:\Users\user\Desktop\dsh-ditto
npm install
npm run demo:spec
```

命令會建立 12 個合成模組並印出本機網址。先核准三份樣本，再生成完整預覽；只有 12 份規格都通過流程檢查後，寫入按鈕才會開啟。

這個示範使用固定的測試生成器，用來驗證流程與安全閘門，不代表真實模型的文件品質。

## 在 DSH 中使用

Ditto 讓 DSH agent 在正常模型回合中讀取證據並提交結構化草稿。插件不保存模型金鑰，也不直接替你呼叫模型。

核心工具包含：

`ditto_spec_create` → `ditto_spec_queue` → `ditto_spec_module` → `ditto_spec_submit` → `ditto_spec_review` → `ditto_spec_revise_samples` → `ditto_spec_approve` → `ditto_spec_apply`

## 驗證與目前範圍

```powershell
npm test
npm run build
npm run smoke:dsh
```

目前已通過 25 項自動測試、TypeScript 建置、DSH 元件宿主 smoke，以及本機瀏覽器的完整預覽閘門驗收。完整證據在[驗證紀錄](docs/VALIDATION.zh-TW.md)。

這是本機開發者原型。完整 DSH CLI profile 仍需在 Node 24 驗收，真實模型處理真實程式庫的品質與時間節省也尚待量測。

## 延伸閱讀

- [產品路線圖](docs/ROADMAP.zh-TW.md)
- [M1 工程合約](docs/M1-CONTRACT.md)
- [M1 評估方法](docs/M1-EVALUATION.zh-TW.md)
- [實作狀態](docs/IMPLEMENTATION-STATUS.zh-TW.md)
- [驗證紀錄](docs/VALIDATION.zh-TW.md)

## License

[MIT](LICENSE)
