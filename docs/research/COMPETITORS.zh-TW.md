# 產品選擇與競品紀錄

查核日：2026-09-13。以作者 GitHub README、官方公告與 DSH 插件目錄搜尋為主；目錄可遺漏、描述可能落後，不是完整市場普查。本輪選擇是產品判斷，沒有對使用者進行訪談或付費意願測試。

## 選擇：樣本先行的批次工作台

工作名稱 DSH Ditto。核心流程：代表樣本 → 使用者改結果 → 可讀配方 → 全批預覽 → 副本輸出與例外處理 → 下一批沿用。

| 已有產品 | 已有能力 | Ditto 需要證明的差異 |
|---|---|---|
| [dsh-plugin-folder-tidy](https://github.com/9Epuuuu/dsh-plugin-folder-tidy) | 副檔名分類、資料夾整理 | 依內容提出建議、樣本修正、一致套用、操作預覽 |
| [dsh-file-rename](https://github.com/uckkk/dsh-file-rename) | 字串取代、前後綴、大小寫與 dry run | 以結果教導配方，而非要求理解改名規則 |
| [dsh-batch-pipeline](https://github.com/Culeot/dsh-batch-pipeline) | 批次清單、進度、預算與重啟續跑 | 一般使用者能直接操作的真實樣本與例外處理 |
| [dsh-action-outbox](https://github.com/JimChen-g/dsh-action-outbox) | 任意工具的 stage／review／approve／commit | 文件專用的可見成果，不要求審核工具 JSON |
| [dsh-knowledge-base](https://github.com/htcqp802/dsh-knowledge-base) | 文件匯入、搜尋、資料夾管理 | 產生可帶走的整理結果，聚焦反覆的批次工作 |
| [dsh-docs](https://github.com/Sqhao-O/dsh-docs)、[dsh-cowork](https://github.com/Jesse-njx/dsh-cowork) | 文件／Office／OCR 能力 | 可作為解析與輸出能力來源，不重造其引擎 |

M0 的規則改名與複製本身不構成以上完整差異。M1、M2 若沒有通過樣本修正與一般使用者操作驗收，不應以完整產品故事宣傳。

## 淘汰或降級的方向

| 方向 | 已有直接或高度相近產品 | 決定 |
|---|---|---|
| 驗證凭證／舊 PASS 防護 | [dsh-verification](https://github.com/bpc-oss/dsh-verification) | 不當新旗艦，也避免回到 KeepGate 的低收益治理 |
| 對話交接／恢復 | [dsh-session-handoff](https://github.com/snow-The/dsh-session-handoff)、[dsh-chat-import](https://github.com/Nwflower/dsh-chat-import) | 與既有插件及上游重疊 |
| 升級安全／相容性 doctor | [dsh-compat-guard](https://github.com/Shizuku-keop/dsh-compat-guard)、[dsh-plugin-upgrade-skill](https://github.com/oh-my-dsh/dsh-plugin-upgrade-skill) | 使用現有經驗管理開發環境，不作主產品 |
| 泛用回滾 | [dsh-undo](https://github.com/23swccp/dsh-undo)、[dsh-file-undo](https://github.com/QinLuza/dsh-file-undo) | 功能已有；首版採保留原檔的副本輸出 |
| 通用文件比較表 | [NotebookLM Data Tables 官方公告](https://blog.google/innovation-and-ai/models-and-research/google-labs/notebooklm-data-tables/)、[官方表格匯出說明](https://support.google.com/gemininotebook/answer/16206563?hl=zh-Hans)、[Hana Research](https://github.com/zhoupengyun572-cell/dsh-hana-research) | 直接競爭過強；保留更具體的「報價缺項」用途作後續候選 |

## 冷啟動與留存假設

傳播素材只拍一件事：把難找的 20 份文件變成有秩序、能帶走的新資料夾，示範一次修正如何影響全批。配方分享只含規則與範例結構，預設不附私人檔案、來源全文或本機路徑。

先放在 DSH 社群與原生插件目錄測試；尚未發布或對外發訊息。不要先做付費牆、帳號、雲端後台或廣告投放。重用配方、第二批成功率與人手時間才是早期指標，下載量與星數只是曝光訊號。

對外可說：「我們已查的 DSH 插件中，尚未找到完整對應這套樣本修正到批次執行的流程。」不能說：「全球首創」、「解決大多數人的痛點」或「已證明爆款」。
