# DSH 版本查核

查核日：2026-09-13。

| 位置／通路 | 結果 |
|---|---|
| 本機 `C:/Users/user/Desktop/deepseek-harness` | `0.1.0-rc.5`；HEAD `47f943859bef60e4160492346772ded9b24f765a`；commit 日期 2026-08-13；查核時 working tree clean |
| GitHub 最新 release | `dsh-v0.1.5-rc.2`；2026-09-10 15:09:34 UTC；commit `fb2c4b9e698e30edb738bca4cf0618587db7d203` |
| npm `@deepseek-ai/dsh/latest` | 觀測當下回傳 `0.1.5-rc.1`，與 GitHub release 通路不同 |
| npm 公開套件 | `@deepseek-ai/dsh-tools`、`dsh-agent`、`dsh-web` 的 `0.1.5-rc.1` 可取得 |

新版已新增／調整：DeepSeek-V41-Flash 與圖片能力、一般附件、右側多頁籤與多格式預覽、文件交付、可繼續的子代理訊息、長會話效能、Windows 子程序體驗。Session 已到 V3；Web slots、SessionHandle 和 agent 相關 API 有破壞性改變。

依據：[官方仓庫](https://github.com/deepseek-ai/deepseek-harness)、[0.1.5-rc.1 發布說明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.1)、[0.1.5-rc.2 發布說明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.2)、[本機至新版 diff](https://github.com/deepseek-ai/deepseek-harness/compare/47f943859bef60e4160492346772ded9b24f765a...dsh-v0.1.5-rc.2)、[npm 觀測端點](https://registry.npmjs.org/@deepseek-ai/dsh/latest)。

新專案採隔離環境測試。沒有直接 git pull 本機 DSH，沒有改使用者 profile 或遷移真實 session。這次的 npm／GitHub 不同版本只是兩個通路的觀測結果，不能自行解釋為 npm 安裝有問題。
