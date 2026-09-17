# Ditto｜先改幾份，其餘照樣做

**Review a few. Ditto the rest.**

給 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的審閱優先批次插件：先看少量樣本、調整到滿意，再讓其餘工作照樣完成。整批預覽，核准後才寫入。

[![npm](https://img.shields.io/npm/v/dsh-ditto.svg)](https://www.npmjs.com/package/dsh-ditto)
[![CI](https://github.com/darrien1998/dsh-ditto/actions/workflows/ci.yml/badge.svg)](https://github.com/darrien1998/dsh-ditto/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-0e7490.svg)](https://github.com/topics/dsh-plugin)

[English](README.md) · [繁體中文](README.zh-TW.md)

AI 做一份很快。Ditto 解決的是做 50 份時，你不必盯 50 次。

你照平常的方式描述批次工作。Ditto 挑出幾份有代表性的樣本，讓你審閱、修改到滿意，再把同一套標準套用到其餘項目——先給你完整預覽，取得核准後才寫入。你沒有點頭，什麼都不會寫。

```text
掃描 → 審閱 3 份樣本 → 核准 → 預覽全部 → 寫入
```

![dsh-ditto demo：掃描 16 個模組、審閱 3 份樣本、核准、預覽全部、寫入 16/16，來源檔案 0 個被修改](https://raw.githubusercontent.com/darrien1998/dsh-ditto/main/docs/assets/demo.svg)

## 安裝

Ditto 是原生 DSH 插件，一行指令裝進 DSH profile：

```bash
dsh plugin --profile web add dsh-ditto
```

`dsh plugin` 會在 profile 目錄內轉呼叫 pnpm，所以 PATH 上要有 [pnpm](https://pnpm.io)。需要的話把 `web` 換成 `headless`、`acp` 或你自訂的 profile 名稱。

| | |
|---|---|
| **更新** | `dsh plugin --profile web update dsh-ditto` |
| **移除** | `dsh plugin --profile web remove dsh-ditto` |
| **檢查** | `dsh plugin --profile web exec dsh-ditto doctor` |

doctor 用白話輸出檢查結果：

```text
✓ Ditto 0.1.0
✓ Node.js 22.23.1
✓ dsh 0.1.5-rc.1 detected
✓ pnpm 11.22.0 detected (used by "dsh plugin")
✓ dsh-ditto is installed in profile "web" and listed in its bundles
✓ 14 of 14 tools registered
✓ skill "ditto" registered
✓ stateRoot /your/project/.dsh-ditto is writable
```

需求：Node.js 22 以上、DSH 0.1.5-rc.1 以上（見[相容性](#相容性)）。若 doctor 說 host 套件還找不到，先啟動一次 profile（`dsh web`）讓 DSH 建立連結，再跑一次即可。

## 快速開始

在你要處理的 repository 裡啟動 DSH，用自然語言提出批次需求：

> 把 `src/` 底下每個模組都寫成格式一致的 Markdown 規格，先讓我看三份樣本。

不必說「用 Ditto」，也不必記工具名稱。當需求涵蓋整個資料夾、多個相似模組、重複的轉換，或是值得先審閱再批次寫入的工作，DSH agent 會透過 `ditto` skill 走這條流程；單檔修改與一般問答不會觸發。

想先看流程再安裝？demo 不需要模型、不需要 API key：

```bash
npx dsh-ditto demo --headless   # 終端機逐步輸出，16 個合成模組
npx dsh-ditto demo              # 同一批工作，在本機瀏覽器審閱頁操作
```

## 範例：程式碼 → 規格

Ditto 的第一個用途：把 TypeScript／JavaScript 程式庫變成格式一致、每句都有來源證據的 Markdown 規格。

1. **掃描。** 掃描資料夾（略過 `node_modules`、建置輸出、測試、宣告檔），清楚列出哪些在範圍內、哪些被排除以及原因。
2. **審閱三份樣本。** 挑出三個結構不同的模組——匯出最多的、import 最多的、最小的——agent 依真實、帶行號的來源證據各寫一份規格。你直接改 Markdown，改到你要的樣子。
3. **核准。** 核准後的樣本成為整批的標準。
4. **預覽全部。** 其餘每個模組都以同樣風格產生規格。每一句事實都引用來源行號；來源無法支持的內容集中在 **Needs confirmation**，不會被寫成事實。
5. **寫入。** 你核准完整預覽後，Ditto 才把 Markdown 寫進獨立的輸出資料夾——不碰原始碼、不覆寫既有檔案。

## 範例：整理檔案

同一套審閱流程也適用於依一條規則整理檔案副本：

> 把 `inbox/` 裡的檔案依類型整理到 `sorted/`，檔名用 `2026-{stem}`，先給我看計畫。

Ditto 先預覽每個檔案的目的地，讓你逐一修正名稱，然後才在新資料夾建立**副本**。原檔不搬、不改；既有檔案不覆寫；做法可以存成 recipe 下次沿用。

## 運作方式

```text
使用者
 ↓  「每個模組都做規格，先讓我看幾份」
DSH agent
 ↓  透過 `ditto` skill 路由
Ditto 原生工具（ditto_spec_create、…_module、…_submit、…_approve、…_apply、…）
 ↓  給出有界證據，收回經驗證的 JSON 草稿
確定性核心
 ↓  掃描 · 證據 id · 引用驗證 · 渲染 · hash · digest
預覽 → 人工核准 → 寫入
```

- **思考交給 agent，記帳交給 Ditto。** Ditto 自己不呼叫模型、不保存模型 API key。它把有界、帶行號的證據交給 DSH agent，只接受每句都引用該證據的結構化草稿。
- **批次是持久的。** 每個計畫與批次都存著 revision 與 digest。改樣本或指示會改變 digest、清除核准，並鎖住其餘模組直到重新核准。寫入中斷後可續跑，已完成的項目不重做、不覆寫。
- **Skill 是路由層，不是產品本身。** [`skills/ditto/SKILL.md`](skills/ditto/SKILL.md) 是你可以直接讀的檔案，插件註冊的就是這個檔案。完整工具參考從實際 schema 產生：[`docs/TOOLS.md`](docs/TOOLS.md)。

## 為什麼用 Ditto

只靠 prompt 做批次工作，容易漂移、漏檔、格式不一、編造細節、太早寫入，中斷後還得重新交代。Ditto 提供：

- **代表性樣本**，不用把格式重講 30 次
- **人工審閱**樣本，你的修改會帶進其餘項目
- **完整預覽**，寫入前看得到每一項
- 每句主張都有**來源證據**，例外**集中處理**
- **明確核准**是硬性閘門，不是建議
- **安全寫入**：只建副本與新檔、重驗 hash、不覆寫
- 中斷後**續跑**，不重複工作

Ditto 不會讓模型更聰明，也不保證規格在語意上正確。它讓批次可審閱、一致、可安全寫入。

## 安全設計

**你的來源不會被動到。核准前不會批次寫入。Ditto 不執行你的程式碼。Ditto 不保存你的模型 API key。**

以下每一項都由程式碼強制並有自動測試覆蓋，對應表在 [`docs/SAFETY.md`](docs/SAFETY.md)：

- 預覽對來源與輸出零寫入，只保存本機審閱中繼資料
- 來源檔只以文字讀取，不執行、不 import、不修改、不搬移、不刪除
- 輸出寫進獨立資料夾；既有目的檔絕不覆寫
- 每次寫入都重新檢查來源 hash 與計畫 revision／digest；來源變動或審閱過期會在任何寫入前被拒絕
- 拒絕路徑跳脫、symlink／junction 逃逸、重複與大小寫不敏感的目的地碰撞
- 續跑不重做、不覆寫已完成項目；重複 apply 不會產生副作用
- 來源無法支持的主張變成 **Needs confirmation** 問題，不會被寫成事實
- 有 DSH approval service 時，每次批次寫入前 host 會再向使用者確認（`approval: host`）
- 沒有 telemetry，除 DSH 本身外不連網，不保存 API key

## 插件架構

Ditto 是 DSH 插件，不是一份 Markdown skill。套件包含：

| 層 | 內容 |
|---|---|
| Cordis service | `dsh-ditto/dsh`——一個 service，在 host 公開的 `skills` 與 `tools` service 上註冊 skill 與工具；卸載 bundle 就全部移除 |
| Skill | `skills/ditto/SKILL.md`——agent 讀的路由層（模型與使用者皆可呼叫） |
| 原生工具 | 14 個具型別的工具：9 個給程式碼 → 規格、5 個給檔案整理（[參考](docs/TOOLS.md)） |
| 確定性核心 | 掃描、證據擷取、引用驗證、渲染、hash、revision／digest 閘門、持久狀態 |
| 本機審閱頁 | 選用的 loopback-only 瀏覽器頁面，供 demo 與 `dsh-ditto serve` 使用 |

Ditto 只依賴公開的 DSH API（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-skill`），不 patch DSH 任何東西。設定（`workspaceRoot`、`stateRoot`、`approval`、分頁上限）由 profile 的 `cordis.patch.yml` 提供，詳見 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

## 相容性

| Ditto | DSH | Node.js | 狀態 |
|---|---|---|---|
| 0.1.0 | 0.1.5-rc.1、0.1.5-rc.2 | 22、24 | 支援——完整 CI 閘門、真實 `dsh plugin` 安裝 smoke |
| 0.1.0 | 0.1.6-alpha.1 | 22、24 | canary——測試通過，CI 非阻斷工作 |

DSH 仍在快速開發；實際測了什麼、如何回報 breaking change，見 [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md)。

## 開發

```bash
git clone https://github.com/darrien1998/dsh-ditto.git
cd dsh-ditto
npm ci
npm run build
npm test                 # 單元、核心安全、UI、插件契約、CLI
npm run smoke:dsh        # 真實 Cordis + ToolRuntime + SkillRegistry 元件宿主
npm run smoke:tarball    # 打包、乾淨安裝、掛載、執行已安裝的 CLI
npm run smoke:profile    # 在隔離 DSH_HOME 用真實 `dsh plugin add` 安裝（需要 dsh 與 pnpm）
```

更多見 [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)。

## 貢獻

歡迎 issue 與 pull request，請看 [CONTRIBUTING.md](CONTRIBUTING.md)。適合入手的方向：Python、Java、C#、Go 的 language adapter（介面很小、有文件）、自訂規格範本、更好的樣本挑選、UI 在地化、文件範例。可以從 `good first issue` 與 `help wanted` 標籤開始。

## 路線圖

見 [`docs/ROADMAP.md`](docs/ROADMAP.md)。一句話：讓 Ditto 保持小、好懂、安全、DSH 原生、審閱優先。不做背景監看、不做排程、不做無人值守的批次寫入。

## 授權

[MIT](LICENSE)
