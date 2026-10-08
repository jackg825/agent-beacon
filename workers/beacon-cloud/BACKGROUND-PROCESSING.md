# 背景整理（第二階段）

這份文件說明第二階段已實作的背景整理：規則與隱私、持久背景工作、不連網的規則式摘要、可選的 Jev 篩選，以及外部呼叫的預算與 ledger。它**預設完全關閉**；部署這份程式不會改變既有 TEST 的行為，直到 operator 明確開啟排程，且審閱者明確啟用政策。外部呼叫另外需要 operator 的部署允許清單與專屬金鑰。

已實作：

- 處理政策：工作區上限、專案收窄、欄位類別、整理時機，每次修改都留稽核。
- 遮蔽與投影：只把政策允許的欄位類別放進投影，所有字串先遮蔽 credentials 與使用者路徑。
- 持久背景工作：以來源集合決定工作身分、以「涵蓋」取代時間水位、每個範圍同時只有一份進行中工作、租約與重試、執行前重新檢查政策與範圍。
- `beacon.extractive.v1`：只根據原始事件投影產生固定四節、每一點都有來源編號的「自動整理・待審」候選。
- 可選 Jev 篩選：只產生未校準的訊號；只有在部署閘門、政策、金鑰與預算預約都通過時才會呼叫，預設不會略過任何工作。
- 外部呼叫預算：每日呼叫數、token、供應商回報金額上限，原子預約、結果不明一律計入、同一份工作不重送。
- Dashboard「背景整理」分頁（政策、工作、預算與今日用量、未校準訊號）、兩個唯讀 MCP 工具。

仍延後：**模型生成**。要等記錄好供應商、模型、secret 管理、可送資料範圍與每日美元上限之後才會開始（見下文）。目前唯一的外部呼叫是可選的 Jev；secret 一律使用這個服務專屬的值，不借用其他 Cloudflare 專案或應用程式的 secret。

本機合成驗證結果由 [VALIDATION.md](VALIDATION.md) 記錄；這份文件不是雲端部署或真實資料的驗收紀錄。

## 前提與部署順序

- **需要 Workers Paid。** Free 方案的 cron 只有 10 ms CPU、50 個 subrequest、50 個 D1 查詢，不足以跑任何背景整理。Paid 方案每 15 分鐘的 cron 有 30 秒 CPU、1,000 個 D1 查詢。無論哪個方案，未開啟時程式都維持不執行。
- 先套用 `migrations/0004_processing.sql`，再部署新程式。新的 context 查詢會讀取 `context_generation`；程式先上、migration 後上，筆記查詢會回傳 `503`（ingest 不受影響）。
- 0004 只新增 tables、indexes 與 triggers，沒有 down migration。退版時保留所有 tables，回復上一個 Worker 版本即可。
- `wrangler.jsonc` 已有兩個 cron：`*/15 * * * *` 跑 `processing`，`17 * * * *` 留給備份與資料健康。共用帳號的 cron 數量另有帳號上限。

## 逐步開啟

1. 套用 0004 並部署（見上）。這時什麼都不會發生。
2. 在 Worker vars 加入 `MAINTENANCE_TASKS=processing`。沒有這個名稱，排程不執行任何查詢。
3. 用審閱金鑰設定工作區政策。工作區列是上限，沒有它就等於全部關閉：

   ```text
   POST /api/processing/policies
   {"scope_type":"workspace","scope_id":"*","enabled":true,"external_allowed":false,"jev_enabled":false,
    "summary_fields":["command_text","file_path","tool_name","titles"],"external_fields":[],
    "min_new_events":20,"quiet_minutes":30,"max_events_per_job":200,"jev_skip_threshold":null}
   ```

4. 需要時對單一專案再收窄，例如只允許中繼資料或關閉某個專案：`{"scope_type":"project","scope_id":"REPLACE_WITH_CENTRAL_PROJECT_SHA256",...}`。
5. 等下一次排程，或用 `POST /api/processing/run` 立即規劃一個任務或專案。
6. 在「交接與記憶」切換到「待審・尚未採用」，審閱標示「自動整理・待審」的候選。核准、拒絕與修訂流程和手動筆記相同。
7. 只有在需要 Jev 訊號時，才依「可選 Jev 篩選」另外開啟；摘要本身不需要任何外部呼叫。

要停止：把工作區 `enabled` 改成 `false`（已排入的工作會在執行前重新檢查並以 `policy_changed` 略過），或從 `MAINTENANCE_TASKS` 移除 `processing`。兩者都不會刪除任何資料。

## 政策

每份政策是整份取代，所有欄位都必須提供；版本號遞增，`processing_policy_audit` 保存每一版的完整內容與 actor。

| 欄位 | 意思 | 預設／範圍 |
| --- | --- | --- |
| `enabled` | 是否規劃這個範圍的工作 | `false` |
| `external_allowed` | 是否允許 `external_fields` 的內容離開工作區（目前只送往 Jev） | `false` |
| `jev_enabled` | 是否允許 Jev 篩選 | `false` |
| `summary_fields` | 本機規則摘要可以使用的欄位類別 | `[]` |
| `external_fields` | 可以送出工作區的欄位類別，必須是 `summary_fields` 的子集 | `[]` |
| `min_new_events` | 未涵蓋事件至少幾個才整理 | 20（1–1000） |
| `quiet_minutes` | 最新一批事件送達後要安靜多久 | 30（0–1440） |
| `max_events_per_job` | 一份工作最多幾個事件 | 200（1–200） |
| `jev_skip_threshold` | Jev 新資訊低於此值才可略過；`null` 代表永不略過 | `null` |

生效政策的算法：

- 沒有工作區列 ⇒ 內建預設（全部關閉）。專案列單獨存在也不會啟用任何東西。
- 布林值是「工作區 AND 專案」；欄位類別取交集；`max_events_per_job` 取較小值；`jev_skip_threshold` 兩邊都設定才存在，取較小值。
- 時機（`min_new_events`、`quiet_minutes`）使用專案列；沒有專案列就沿用工作區列。
- `policy_hash` 是生效政策內容的 SHA-256，不是列的版本號。任何會改變行為的修改都會改變它。

外部呼叫另有部署時的閘門：`EXTERNAL_PROCESSING_PROJECTS`（逗號分隔的中央專案 ID 或 `*`）必須列出該專案、生效政策允許 `external_allowed` 與 `jev_enabled`、`JEV_API_KEY` 存在、端點與模型設定有效，而且每日預算預約成功。前四項是 operator 的部署設定，審閱金鑰改不了；審閱者的政策與預算只能在 operator 開放的範圍內使用。`GET /api/processing/policy?project_id=` 的 `external_gate` 顯示前幾項目前是否成立，預約要到實際呼叫前才會發生。

## 欄位類別

下列中繼資料永遠可以使用：`event.action`、`event.kind`、`timestamp`、`harness.name`、指令結束碼、`gen_ai.usage` 數字（token、回報費用）與核准決定（以及 `policy.enforcement` 這類短代碼）。中央裝置 ID 與 session ID 用來計數，不是事件內容。

| 類別 | 來源 |
| --- | --- |
| `file_path` | `file.path`、`tool.path`；未允許時只保留副檔名 |
| `tool_name` | `tool.name`、`mcp.server/mcp.tool`、`gen_ai.tool.name` |
| `command_text` | `command.command`、`tool.command` |
| `command_output` | `command.output`、工具呼叫結果 |
| `prompt_text` | `prompt.text` |
| `response_text` | `agent.*` 事件的 `message`、`gen_ai.output.messages` |
| `file_diff` | `file.diff` |
| `tool_input` | 工具呼叫參數、`tool.input` |
| `titles` | 任務標題、筆記標題、專案名稱（摘要標題與 Jev state） |
| `approved_note_text` | 已核准筆記內容（只給 Jev，摘要不使用） |
| `raw` | `raw` 物件、非 agent 事件的 `message`、錯誤訊息 |

其他欄位（repo 網址、主機名稱、使用者、工作目錄等）一律不放進投影。

## 遮蔽

每個放進投影或摘要的字串都經過遮蔽：

- 移植上游 `pkg/asymptoteobserve/privacy.go` 的規則（指定值、`Authorization: Bearer`、bearer、`sk-`），並擴充 key 名稱（`passwd`、`pwd`、`credential(s)`、`private_key`、`access_key`、`secret_access_key`、`AWS_SECRET_ACCESS_KEY`、`client_secret`、`cookie`、`session`）與 JSON 寫法（`"api_key": "…"`）。
- 另外移除：本服務的裝置金鑰 `bcn_cf_…`、`bcn_device_…`、`sk-ant-`／`sk-proj-`／`sk-svcacct-`／`sk-admin-`、AWS `AKIA`／`ASIA`、GitHub `gh[pousr]_`／`github_pat_`、Slack `xox[abprs]-`、PEM private key 區塊（包含被截斷的；前面有 `private_key=`、`"private_key": "…"` 等標籤時也整塊移除，標籤規則之前就先處理）、JWT、Google `AIza…`、網址中的帳密，以及本 Worker 自己的 `READ_TOKEN`、`MCP_TOKEN`、`REVIEW_TOKEN`、`JEV_API_KEY`（8 字元以上）。
- 先遮蔽整個字串再截斷（每個字串最多 1,200 字元），截斷後再遮蔽一次，不會留下金鑰前綴。
- 在整份投影中收集「被指定給機密 key 的值」，之後在任何事件、任何欄位裸露出現時也一併移除。
- `/Users/<名稱>/`、`/home/<名稱>/`、`C:\Users\<名稱>\` 換成 `~/`（JSON 文字中加倍的反斜線也一樣）；位在 session 工作目錄下的檔案路徑改成相對路徑。
- 結構化的值（工具輸入、`gen_ai` 訊息與結果、`raw`）在序列化前先逐一遮蔽其中會被跳脫的字串，序列化後整段再遮蔽一次；這些字串中指定給機密 key 的值也會被收集。
- 整份投影最多 120,000 字元，超過的內容欄位會省略，摘要會註明已截斷。

這是規則式遮蔽，不是完整的 DLP。允許更多欄位類別之前，先用合成資料確認輸出。

## 整理範圍與「涵蓋」

- **任務範圍**：一個進行中任務在某一個專案內的已連結 session 事件（筆記只屬於單一專案，跨專案任務會產生多個範圍）。
- **專案範圍**：該專案中**沒有**被任何進行中任務連結的 session 事件。任務完成後，它的 session 會回到專案範圍，之後的專案摘要可能再次整理這些事件。
- 每個範圍都要求該專案的生效政策 `enabled=true`；預設政策下，即使有進行中任務也不會產生任何工作，`POST /api/processing/run` 回傳 `409`。
- 只處理 runtime 事件，不處理 inventory。

排程不使用時間水位，而是記錄「涵蓋」：`processing_coverage(scope_key, event_id)`。某個事件在一個範圍內，直到該範圍有一份工作以 `succeeded` 或一般的 `skipped` 結束並涵蓋它，才不再待整理。因此：

- 每份工作選擇最舊的未涵蓋事件（依 `timestamp`、`id`），最多 `max_events_per_job` 個；超過的事件留給下一份。450 個事件會變成 200、200、50 三份，每個事件剛好涵蓋一次。
- Mac 睡眠或斷線後補送的事件，即使時間戳比已整理的更早，仍會進入下一份工作。
- 事後才連結到任務的 session，它的舊事件也會在下一份任務工作中整理。
- 範圍到期的條件：未涵蓋事件至少 `min_new_events` 個，而且最新一個未涵蓋事件所在批次的 `received_at` 早於「現在 − `quiet_minutes` − 2 分鐘」。多出的 2 分鐘是批次寫入 D1 前就打上時間的緩衝。
- 每次排程最多檢查 5 個範圍，依穩定順序輪替；輪替位置以 compare-and-swap 前進，重疊的排程不會重複規劃。
- 規劃只查 D1，不讀 R2。
- 一個範圍有排隊中、執行中或失敗的工作時不再規劃；有一份尚未審閱的自動整理候選時也先延後。下一份會涵蓋這段期間的所有新事件。
- `POST /api/processing/run` 只略過最少事件數與安靜時間；政策關閉、已有工作或待審候選的規則仍然適用，執行仍在下一次排程。

查詢未涵蓋事件需要掃描範圍內的事件索引，讀取列數大致和該範圍的事件數成正比。個人兩台 Mac 的規模可接受；事件量大時需留意 D1 的 rows read。

## 工作生命週期

工作身分 `id = sha256(['summarize', scope_key, source_set_hash, policy_hash, processor_version])`，`source_set_hash` 是排序後的「中央事件 ID:索引 payload hash」。相同輸入只會有一份工作；規劃時就把來源寫進 `processing_job_sources`。

| 狀態 | 意思 |
| --- | --- |
| `queued` | 等待執行，`next_attempt_at` 之後可被領取 |
| `running` | 已領取，持有租約 |
| `succeeded` | 已產生候選並涵蓋來源 |
| `skipped` | 沒有產生候選；`skip_reason` 說明原因 |
| `failed` | 重試用完，等待人工重試或放棄；同範圍不再規劃 |
| `dismissed` | 審閱者放棄；不涵蓋任何事件 |

- 領取是一個原子的 `UPDATE … RETURNING`，選擇最早到期的排隊工作或租約已過期的執行中工作，嘗試次數加一，租約至少 10 分鐘（排程剩餘時間＋外部逾時＋1 分鐘）。
- 失敗會在 1、5、30 分鐘後重試，第 4 次嘗試失敗後變成 `failed`（不再排定下次時間，只能由審閱者重試或放棄）；最後一次嘗試中斷而租約過期的工作由排程標成 `failed`（`lease_expired`）。
- 每個完成動作都先寫入 `processing_job_fence`：只有仍持有同一租約（owner＋嘗試次數）的執行者才能完成，否則整個 D1 batch 回滾。
- 成功是一個 D1 batch：候選、來源、密封、建立稽核、`context_generation`、涵蓋、工作完成。`context_generation.job_id` 是 UNIQUE，同一份工作不可能有第二份候選；領取後若發現這份工作已有候選，只會補記錄，不會重做。
- **執行前重新檢查。** 領取後、讀取任何原文之前，重新計算生效政策；`policy_hash` 不同就以 `policy_changed` 略過。接著重新讀取每個來源事件目前的專案、session 與任務連結；事件離開專案、任務已完成、或專案範圍的 session 被連到進行中任務，就以 `scope_changed` 略過。這兩種略過不寫涵蓋，排程會重新規劃；若之後政策或範圍改回相同內容，同一份工作會重新排入。
- 原文版本：每個事件優先使用規劃時的版本；若它的專案／session／harness 與中央索引不符，改用同一事件另一個相符的版本；都不符就排除並只記錄數量。原文缺失或雜湊不符是服務錯誤（重試），不會改用其他版本代替。
- 投影只在執行時依當時的政策建立；`input_hash`（投影＋政策雜湊）只供稽核。

| `skip_reason`／`last_error` | 意思 |
| --- | --- |
| `policy_changed` | 規劃後政策改變，未做任何處理 |
| `scope_changed` | 規劃後來源離開範圍，未做任何處理 |
| `low_signal_only` | 全部是 session 開始／結束、心跳、inventory 這類低訊號事件（會涵蓋） |
| `no_matching_versions` | 沒有任何來源有相符的原文版本（會涵蓋） |
| `raw_unavailable` | R2 原文缺失或損壞（重試） |
| `lease_expired` | 最後一次嘗試沒有完成 |
| `invalid_source`／`context_conflict` | 寫入候選時來源範圍不符（重試時通常變成 `scope_changed`） |

審閱者可以 `POST /api/processing/jobs/:id/retry`（`failed` → `queued`，嘗試次數歸零）或 `POST /api/processing/jobs/:id/dismiss`（`failed`／`queued` → `dismissed`），可附 `reason`，都會留在 `processing_job_audit`。放棄不會涵蓋事件：相同來源不會再自動處理，有新事件時會規劃包含舊事件的新工作。

已知限制：放棄的工作若已經是 `max_events_per_job` 個來源，最舊的未涵蓋事件不會因新事件而改變，該範圍會停在同一組來源，直到政策改變（例如調整 `max_events_per_job`）。同理，R2 原文永久遺失但 D1 索引仍在的事件，會讓包含它的工作一再失敗。目前沒有「人工確認略過這些事件」的操作；遇到時先用資料健康檢查修復原文，或調整政策。

## 規則式摘要 `beacon.extractive.v1`

不連網、不使用模型。每次都從原文投影重建，不摘要上一份摘要。

- 最多 20 個來源，優先選擇：未解決的失敗、之後成功的失敗與那次成功、驗證指令、核准決定、檔案變更，再補最新事件。
- 固定四節：`## 進度`（裝置、session、時間範圍、動作統計、檔案變更、已解決的失敗）、`## 決策`（核准／政策決定；沒有就寫「紀錄中沒有明確決策」）、`## 已驗證結果`（允許 `command_text` 時，結束碼 0 且像 test/check/build/lint 的指令；否則只列動作與結束碼）、`## 待辦與風險`（之後沒有成功的失敗；任務範圍註明任務仍在進行中）。
- 每一個項目結尾都有 `[n]`，`n` 對應候選第 n 個來源（`context_sources` 的 ordinal＋1），都是持久保存的精確事件版本。
- 標題 `自動整理：<任務標題或專案名稱>（日期）`；未允許 `titles` 時改用 `任務 xxxxxxxx`／`專案 xxxxxxxx`。內容最多 12,000 字元，寫入前再遮蔽一次。
- 候選一律是 `pending` 的 `summary`，`supersedes_id` 為空，建立者是 `pipeline:beacon.extractive@1`。同一範圍的上一份自動整理記在 `context_generation.previous_context_id`，不使用取代關係。

`src/generator.ts` 的 `Generator` 介面是日後模型生成的接點，必須維持相同輸出規則。模型生成**尚未提供**，也沒有任何 `GENERATOR_*` 設定。要開始之前，先記錄選定的供應商、模型、secret 管理、可送出的欄位範圍與每日美元上限，先跑合成資料與受控供應商測試，再另外決定是否允許真實私人內容。使用這個服務專屬的 secret，不借用其他 Cloudflare 專案或應用程式的 secret。

## 可選 Jev 篩選（只產生訊號）

Jev（TypeSafe System One）只回答三種問題：新活動是否有已核准筆記沒有的新資訊、是否與任務相關、是否與某一則已核准筆記矛盾。它不刪原文、沒有審閱權限、不核准也不修改任何筆記；回答以「未校準分數」保存，只供人參考。預設不會因為 Jev 的回答略過任何工作。

### 開啟步驟

1. operator 準備這個服務專屬的 Jev 金鑰，用 `wrangler secret put JEV_API_KEY` 設定。不要借用其他 Cloudflare 專案或應用程式的 secret。
2. operator 在 Worker vars 設定 `EXTERNAL_PROCESSING_PROJECTS`：允許送出的中央專案 ID（逗號分隔），或 `*`。沒有這個 var，無論政策怎麼設定都不會有外部呼叫。
3. 需要時設定 `JEV_ENDPOINT`（預設 `https://api.typesafe.ai/v1/systemone`）與 `JEV_MODEL`（預設 `jev-latest`）。端點必須是 https，不能含帳密、query 或 fragment，也不能指向這個 Worker 的 `PUBLIC_URL` 主機；不符合就停用 Jev。
4. 審閱者在工作區（與專案）政策打開 `external_allowed` 與 `jev_enabled`，並在 `external_fields` 列出可以送出的欄位。至少要有 `titles`（只能問任務相關性）或 `approved_note_text`（才能問新資訊與矛盾）；兩者都沒有時不會呼叫。
5. 審閱者設定每日預算（見下一節）。沒有預算列或上限為 0 時不會呼叫。
6. 等下一次排程。工作詳細資料列出 Jev 訊號與外部呼叫紀錄，dashboard「背景整理」顯示今日用量。

要停止：關掉政策的 `jev_enabled` 或 `external_allowed`、把預算上限改成 0，或從 `EXTERNAL_PROCESSING_PROJECTS` 移除專案。已排入的工作執行前會重新檢查政策（`policy_changed`），預約在每次呼叫前才進行，所以下一次呼叫就會停止。

### 送出的內容

- `state.events`：執行時依當時政策建立的遮蔽投影，再收窄到 `external_fields`。中繼資料（動作、類型、時間、harness、結束碼、核准決定、usage 數字）一律包含；`file_path` 不在 `external_fields` 時只送副檔名。
- `state.approved_notes`：只有 `approved_note_text` 在 `external_fields` 時才送，最多 10 則屬於該範圍專案的現行 authoritative 筆記（任務範圍包含該任務與全專案筆記，依建立時間由新到舊），從不包含其他專案或分享進來的筆記。每則有 ID、種類、遮蔽後最多 2,000 字元的內容與原文 SHA-256；標題只在 `titles` 允許時才送。
- `state.scope`：範圍類型；`titles` 允許時加上任務標題與專案名稱。
- 送出前先從尚未遮蔽的筆記內容與標題、任務標題、專案名稱與事件（包括只在本機整理的欄位）收集「指定給機密 key 的值」；筆記、標題與事件都用這些值和本 Worker 自己的 secrets（包括 `JEV_API_KEY`）遮蔽之後才截斷，所以一處指定的值不會在另一處裸露，也不會在截斷處留下前綴。
- 超過預算的 `max_input_chars` 時，依上游方式保留開頭與結尾的事件並插入省略標記，必要時再從最舊的筆記開始移除（連同它的矛盾問題）。只會整個移除事件或筆記，不會切斷字串；連一個事件都放不下就不呼叫。

### 問題與 wire contract

Request 與上游 `cli/beacon/internal/learning/evaluator.go` 相同：`POST {model, state, questions}`，每個問題是 `{"type":"noul","instructions":…,"criteria":{"true":…,"false":…}}`，header 為 `Authorization: Bearer <JEV_API_KEY>`。回答讀 `answers[id].noul`（其次 `probability`、`score`）與 `confidence`，也接受舊的 `questions`／`results` 陣列；只採用實際問過的問題、只保存數字。供應商回傳的 `model`、說明或任何文字都不保存，訊號的 `model` 是設定的模型名稱。

| 問題 | 何時問 |
| --- | --- |
| `new_information` | 有可送出的已核准筆記時 |
| `task_related` | 任務範圍，且 `titles` 可送出時 |
| `contradiction:<筆記 ID>` | 每一則送出的筆記各一題 |

### 決定

- 每個回答存進 `processing_signals`（`calibrated=0`），API 與 dashboard 一律標示為未校準分數，不代表正確率。
- 只有在政策設定了 `jev_skip_threshold`、`new_information` 低於門檻，**而且**來源中沒有高訊號事件（非零結束碼、工具失敗、拒絕、政策強制）、也沒有任何 `contradiction:*` ≥ 0.5 時，工作才會以 `jev_no_new_information` 略過。這種略過會涵蓋來源（門檻是審閱者校準後的明確選擇），原文仍然保留。有高訊號時照常產生候選並記 `jev_skip_overridden`。
- 門檻預設 `null`，也就是永不略過。設定前先用合成或明確允許的資料記錄校準結果。
- `contradiction:<筆記 ID>` ≥ 0.5 目前只是那一則筆記的訊號；之後的修訂流程才會把它轉成待確認標記。任何情況都不會修改筆記。

### 失敗不影響整理

Jev 只是參考：呼叫失敗時工作照常用規則摘要完成，並在工作上留一個代碼。

| 工作 `note` | 意思 |
| --- | --- |
| `jev_failed` | 呼叫失敗（HTTP 錯誤、轉址、回應過大或格式不符），沒有訊號 |
| `jev_outcome_unknown` | 逾時或連線中斷，供應商可能已處理；已計入預算 |
| `jev_previous_outcome_unknown`／`jev_previous_failed` | 同一份工作先前已呼叫過，重試時不再重送 |
| `jev_budget:<代碼>` | 預約被拒絕：`budget_disabled`、`daily_call_limit`、`daily_token_limit`、`usd_ceiling`、`input_too_large`、`lease_lost` |
| `jev_input_too_large` | 連一個事件都放不進輸入上限 |
| `jev_no_time` | 本次排程剩餘時間不足一次呼叫 |
| `jev_skip_overridden` | 低於門檻，但有高訊號事件或矛盾訊號，照常產生候選 |

## 外部呼叫與預算

### 對外 fetch

所有外部呼叫都經過 `src/external-fetch.ts` 的 `externalFetch`，並使用排程提供、計入配額的 `ctx.fetch`：

- `redirect: 'manual'`（workerd 不接受 `'error'`）；任何 3xx 或 opaque redirect 都記成 `redirect_rejected`，不會跟隨，request body 與金鑰不會送到其他來源。
- `AbortSignal.timeout(timeout_ms)` 涵蓋整個交換；回應 body 以串流讀取，上限 1 MiB。
- 結果只有代碼（`http_<狀態>`、`timeout`、`network_error`、`response_too_large`、`invalid_response`、`redirect_rejected`）。回應 body、例外訊息與 header 不會出現在 `last_error`、API、排程記錄或 log。

### 每日預算

單列 `processing_budget`，用 `POST /api/processing/budget` 整份取代（審閱金鑰；`processing_budget_audit` 保存每一版）。沒有這一列等於所有上限為 0。

| 欄位 | 意思 | 範圍 |
| --- | --- | --- |
| `daily_call_limit` | 每個 UTC 日的呼叫數上限；0 代表停用 | 0–10,000 |
| `daily_token_limit` | 每日計入 token 上限；0 代表停用 | 0–100,000,000 |
| `daily_usd_ceiling` | 每日供應商回報金額上限；`null` 代表不設定 | 0–10,000 或 `null` |
| `max_input_chars` | 每次 request 的字元上限 | 1,000–200,000 |
| `max_output_tokens` | 每次輸出 token 的預估值 | 1–8,192 |
| `timeout_ms` | 每次呼叫的逾時 | 1,000–30,000 |

- **先預約再呼叫。** 每次呼叫前用一個 `INSERT … SELECT` 原子地確認：工作租約仍屬於這次執行、輸入未超過 `max_input_chars`、今日呼叫數低於上限、今日計入 token（有回報用回報值，否則用預估 `ceil(輸入字元/3)+max_output_tokens`）加上這次預估不超過上限、今日回報金額低於美元上限。D1 逐一執行這個陳述式，同時發生的預約不會一起超過上限（測試：上限 1、八個同時預約只成功一個）。
- **每個預約都算數**，不論結果。逾時或連線中斷記成 `outcome_unknown`，不當成成功，也不表示供應商只收一次費用；本機防重只代表這裡不會重送。
- 同一份工作最多呼叫一次 Jev；之後的重試看到既有紀錄就不再送出，成功過的沿用已存的訊號。
- 執行中斷而停在 `reserved` 的紀錄：超過最長逾時 30 秒再加 60 秒，而且該次嘗試已不持有有效租約時，排程把它標成 `outcome_unknown`（`stale_reservation`），仍計入當日用量。
- `reported_cost_usd` 只存供應商回報的 `usage.cost_usd`，不用價目表推算。供應商不回報金額時美元上限不會生效，請以呼叫數與 token 上限為主要限制。

`GET /api/processing/usage?day=YYYY-MM-DD`（讀取權限，預設今天 UTC）回傳預算、當日呼叫數與各狀態數量、計入 token、回報金額、剩餘額度與最近 20 筆呼叫，只有識別值、數量與代碼。

## 權限與稽核

- 背景工作的 actor 是 `pipeline:<處理器>@<版本>`，從不是審閱者身分。0004 的 trigger 讓任何 `pipeline:%` actor 都不能把候選改成核准或拒絕；`context_generation` 只能指向由 pipeline 建立、`pending`、沒有取代關係的 `summary`。
- 讀取 API（包括用量）使用讀取權限；政策、預算、立即整理、重試與放棄都需要獨立的 `REVIEW_TOKEN`；核准自動整理候選和手動候選一樣需要 `REVIEW_TOKEN`。部署閘門與 Jev 金鑰只能由 operator 設定。
- MCP 新增兩個唯讀工具：`beacon_list_processing_jobs`、`beacon_get_processing_job`。工作 API 只回傳識別值、狀態、數量、雜湊與短代碼，不含事件內容或標題；Jev 分數一律標示為未校準（`label: "uncalibrated"`）。
- 排程記錄只包含工作名稱、耗時、呼叫次數與錯誤代碼。

## 成本與界限

- `processing` 每次排程的配額：D1 400、R2 600、fetch 2。每次最多規劃 5 個範圍、執行 2 份工作，每份最多一次 Jev 呼叫；剩餘配額或時間不足一份完整工作（D1 110、R2 260、fetch 1）時就停止，不會做到一半。
- 沒有開啟任何政策時，每次排程只用 4 個 D1 查詢（租約與預約清理、工作區政策、一次領取），不讀 R2、不 fetch。
- 一份工作最多讀 240 個 R2 批次、48 MiB 原文、1,000 個事件版本；超過時記錄短代碼並重試，最後需要人工處理。
- Ingest 不讀寫任何新 table。測試中刪除全部 processing tables 後，ingest 仍正常回應，排程只記錄 `task_failed`。

## API

```text
GET  /api/processing/policy                        工作區列、專案覆寫清單、生效政策
GET  /api/processing/policy?project_id=…           該專案的工作區列、專案列、生效政策、外部呼叫條件、稽核
GET  /api/processing/jobs?status=&project_id=&task_id=&before=&limit=
GET  /api/processing/jobs/REPLACE_WITH_JOB_SHA256  來源識別值與涵蓋、未校準訊號、呼叫紀錄、稽核
GET  /api/processing/usage?day=YYYY-MM-DD          預算、當日用量、剩餘額度、最近呼叫
POST /api/processing/policies                      {"scope_type":"workspace"|"project","scope_id":…,全部政策欄位}
POST /api/processing/budget                        {"daily_call_limit":…,"daily_token_limit":…,"daily_usd_ceiling":…|null,"max_input_chars":…,"max_output_tokens":…,"timeout_ms":…}
POST /api/processing/run                           {"task_id":…} 或 {"project_id":…}，回傳每個範圍的結果與工作 ID
POST /api/processing/jobs/REPLACE_WITH_JOB_SHA256/retry     {"reason":"選填"}
POST /api/processing/jobs/REPLACE_WITH_JOB_SHA256/dismiss   {"reason":"選填"}
```

清單使用 `before` 傳回上一頁的 `next_cursor`，`limit` 為 1–40。所有 POST 都要求 `Content-Type: application/json`，整份 request 上限 64 KiB，拒絕多餘欄位。

## 延後與後續

- **模型生成延後。** `src/generator.ts` 的 `Generator` 介面保留給日後的生成器，沒有任何 `GENERATOR_*` 設定，也沒有 OpenAI 相容的 adapter。要開始之前先記錄供應商、模型、secret 管理、可送出的欄位範圍與每日美元上限的決定。生成器會共用同一個 `externalFetch` 與預算 ledger（`provider='generator'`）。
- **只用專屬 secret。** `JEV_API_KEY` 與日後的生成器金鑰都只屬於這個服務，不借用其他 Cloudflare 專案或應用程式的 secret。
- **真實供應商驗收另外進行。** Jev 目前只用合成資料與假的供應商測過（包括在 workerd 內的 bundled Worker）；真實帳號、金鑰、費用與私人內容需要各自的驗收紀錄。
- **矛盾訊號轉成標記**屬於之後的修訂流程：只會在被問到的那一則筆記上建立待確認標記，不會改變核准狀態。
- `src/processing-stage.ts` 的 `SelectionStage` 介面仍是規則篩選與 Jev 之間的接點：任何 stage 都只能新增訊號或在政策門檻下略過，遇到高訊號事件時不得略過（`isHighSignal`）。
