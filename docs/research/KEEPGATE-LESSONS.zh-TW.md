# KeepGate 復盤摘要

查核日：2026-09-13。來源是本機 `C:/Users/user/Desktop/KeepGate` 的文件、程式與試驗產物；未讀取 .env 或憑證，未修改舊專案。

結論：KeepGate 尚未證明可因果歸因的程式解題能力提升，不能把目前版本一概說成已證明失敗。治理系統能可靠實作，不等於其成本帶來使用者收益。

| 證據 | 正確解讀 |
|---|---|
| README M3C-3 校正後 25 trials，五模式全成功；Standard 約 11.5 秒、Auto 約 45.5 秒中位數 | 小型題庫不能區分能力，卻付出額外成本；舊的 100% vs 80% 主張已撤回 |
| `docs/benchmarks/SWEBENCH_ROUND1.md` 初期 django-13344：真實自寫測試通過、完成授權成立，目標測試仍失敗 | 工具執行誠實，不代表測試有涵蓋真正問題；同模型選 criterion／修改／測試容易形成自我證明 |
| 同文件 2026-08-23 配置校正：此前 governed trials 皆是 observe，非 strict | 不能用那些結果宣稱 strict gate 的成功或失敗 |
| `benchmarks/swebench/results-13344-h1/django__django-13344.json`：2026-09-04 單次成功，F2P 2/2、P2P 356/356 | 新結果不是全部失敗；單次成功也無法證明是 KeepGate 的效果 |
| hard-v6 nested pwsh 缺必要參數，19/19 verification 被錯記為失敗 | 插件本身會增加新的故障來源；測試數量不能代替實際宿主與使用流程測試 |

Ditto 保留的教訓：真實事件與可恢復狀態、hash freshness、不把 unavailable 當 failed、不捏造成功、來源與副作用可追溯。

Ditto 不沿用的包袱：Task／Criterion／Evidence 的使用者操作負擔、通用完成門禁、重複驗證及大套自動治理。新產品直接把價值放在使用者能看見並修正的結果。

KeepGate 既有 `accuracy-verifier.ts`、`accuracy-workspace.ts` 已包含獨立 checker、base/candidate 對照與 freshness，所以「再找一個模型驗證」也不是新方向。
