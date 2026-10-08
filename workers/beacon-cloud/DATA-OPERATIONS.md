# 保存期限、備份還原與資料健康

這一階段補上中央服務的資料維護：查看資料是否完整、把 D1 與 R2 原文備份到另一個私人 bucket、在獨立環境演練還原，以及由審閱者明確套用原始事件的保存期限。所有結果只包含識別碼、數量、雜湊與錯誤碼，不輸出事件內容、筆記內容或憑證。

本機合成測試覆蓋下列流程；它們不是雲端部署或真實資料的驗收證據。正式啟用前仍要在隔離 TEST 上依 [CONTEXT-WORKFLOWS.md](CONTEXT-WORKFLOWS.md) 的方式備份、升級並做合成回歸。

## 預設不做任何事

部署這份程式碼不會改變既有行為：

- 沒有設定 `MAINTENANCE_TASKS` 時，排程不執行任何工作，也不查詢 D1。
- 沒有綁定 `BACKUP` bucket 時，不會備份；`backup` 任務回報 `backup_not_configured`。
- 沒有保存期限時，所有資料永久保存。原文只會在審閱者套用一份已確認的刪除計畫後刪除；沒有排程刪除，也不依任何模型的「不重要」判斷刪除。
- ingest 不讀寫這一階段新增的任何 table；備份或健康檢查失敗不會讓上傳失敗。

背景任務需要 **Workers Paid**。Free 方案的 cron 只有 10 ms CPU、50 個 subrequest 與 50 個 D1 查詢，備份與比對都放不進去；在 Free 上請維持 `MAINTENANCE_TASKS` 空白。Paid 方案上，`backup` 與 `health` 跑在每小時一次的 `17 * * * *` cron（每次可用較長的 CPU 時間），背景整理跑在另一個 `*/15 * * * *` cron。每個任務都有固定的呼叫配額，超過時任務停在乾淨的狀態，下一次從存下的位置繼續：

| 任務 | 每次 D1 呼叫 | 每次 R2 呼叫 | 對外 fetch |
| --- | --- | --- | --- |
| `backup` | 300 | 2,500 | 0 |
| `health` | 60 | 50 | 0 |

## 啟用步驟

以下是待執行的 runbook，本文件沒有替雲端部署提供驗收證據。所有指令都要保留明確的 TEST `--config`，不要改公開的 `wrangler.jsonc`。

1. 照 [CONTEXT-WORKFLOWS.md](CONTEXT-WORKFLOWS.md) 先備份 D1，再在隔離 TEST 依序套用 `0006_data_operations.sql`（只新增 table、index 與 trigger）、`0008_backup_rounds.sql`（只新增欄位、一個 table 與 index）和 `0009_backup_revision_indexes.sql`（只新增 index，需要先有 `0004` 與 `0007`），然後部署。此時仍不會執行任何背景工作。`backup` 任務需要 `0008`；少了它時回報 `backup_schema_missing`。
2. 建立一個**獨立的私人** R2 bucket 給備份使用，不要重用 RAW bucket 或其他專案的 bucket，也不要開公開存取。在 `.local/wrangler.test.jsonc` 的 `r2_buckets` 加上 `{"binding":"BACKUP","bucket_name":"REPLACE_WITH_PRIVATE_BACKUP_BUCKET"}`。
3. 在同一份 TEST config 的 `vars` 設定 `MAINTENANCE_TASKS`，例如 `"health"` 先只做健康檢查；確認結果後再改成 `"backup,health"`。
4. 依需要調整下列 vars（超出範圍時使用預設值）：

| 變數 | 範圍 | 預設 | 用途 |
| --- | --- | --- | --- |
| `BACKUP_INTERVAL_HOURS` | 1–720 | 24 | 距離上一次開始備份多久後排程下一個 checkpoint |
| `BACKUP_MAX_AGE_DAYS` | 1–90 | 7 | 套用保存期限時，可依靠的已驗證備份最舊幾天 |
| `BACKUP_RETENTION_GRACE_DAYS` | 0–365 | 30 | 原文刪除後，BACKUP 裡的複本再保留幾天 |
| `MAINTENANCE_BUDGET_MS` | 1000–600000 | 25000 | 一次排程的總牆鐘時間 |

D1 用量的量級：`health` 每小時最多讀 50 頁 R2 清單（每頁最多 1,000 個 key）和同一範圍的 batch 索引，不對大型 table 做 `COUNT(*)`。`backup` 每個 checkpoint 會把所有 table 完整讀一次（間隔預設 24 小時），原文則只複製新批次一次。

## 資料健康

`GET /api/health/data`（讀取權限）、唯讀 MCP 工具 `beacon_get_data_health` 和 dashboard 的「資料維護」分頁顯示同一份報告。每個發現項目是 `{code, severity, count, sample_ids, hint}`：`sample_ids` 最多 20 個識別碼，`hint` 是給人看的修復建議，不是給 MCP client 執行的指令。

| code | 嚴重度 | 代表什麼 |
| --- | --- | --- |
| `raw_missing` | critical | 中央索引指向的 R2 原文不存在 |
| `backup_integrity_failed` | critical | 完整性檢查發現備份物件缺失或雜湊不符 |
| `backup_raw_source_missing` | critical | 備份時找不到該批次的原文，因此沒有複本 |
| `device_stale` | warning | 未撤銷的裝置超過 48 小時沒有上傳 |
| `ingest_backlog` | warning | 近 24 小時的批次，收到時間比事件時間的中位數晚 1 小時以上 |
| `context_sources_invalid` | warning | 已核准筆記的來源範圍已改變（`authoritative=false`） |
| `open_flags` | warning | 有尚未處理的筆記標記（該 table 存在時） |
| `processing_failed`／`processing_queue_stale` | warning | 背景整理失敗，或佇列中有工作到期超過 6 小時仍未執行（以 `next_attempt_at` 計，重試的舊工作不算積壓；該 table 存在時） |
| `backup_stale`／`backup_failed` | warning | 最近完成的備份超過兩倍間隔，或最近一次備份失敗 |
| `backup_raw_lag` | warning | 收到超過 2 小時仍未複製到 BACKUP 的批次 |
| `retention_raw_delete_pending` | warning | 保存期限已刪除索引，但 R2 原文刪除尚未完成 |
| `resurrected_batch` | warning | 已刪除的批次又被上傳回來 |
| `backup_unverified` | info | 沒有可供保存期限使用的已驗證備份 |
| `backup_not_configured`／`backup_not_scheduled` | info | 沒有 BACKUP bucket，或沒有啟用 `backup` 任務 |
| `raw_orphan` | info | R2 有原文但沒有索引（上傳中斷或刪除未完成） |
| `raw_scan_stale` | info | 7 天內沒有完成原文與索引的比對 |
| `context_aging` | info | 已核准筆記超過 30 天，而所屬專案之後有新活動 |

**原文比對（list-diff）**：`health` 任務每次從上次位置起，一頁一頁列出 `batches/` 下的 R2 key（每頁最多 1,000 個，每次排程最多 50 頁，也受配額與時間限制），並用 `batches.r2_key` 索引讀同一個 key 範圍，兩邊互相比對：索引有、R2 沒有是 `raw_missing`；R2 有、索引沒有是 `raw_orphan`。ingest 先寫 R2 再提交 D1，所以上傳 1 小時內的無索引物件視為傳輸中，不算孤兒；索引是在列出 R2 之後才讀的，收到時間 1 小時內、但這次清單裡沒有的索引列同樣視為傳輸中，不算缺失（它的物件可能剛好在清單之後才寫入），下一輪比對會再檢查。累計數字存在 `health_state`，報告顯示**最近一次完整比對**與目前進度；位置在每次排程結束時以 compare-and-swap 存一次，重疊的排程中輸的一方丟棄該次結果，不會重複計數。每小時最多比對 50,000 個 key，所以 7 天內完成一輪的上限約是 840 萬個原文物件；超過時 `raw_scan_stale` 會長期出現，代表比對跟不上而不是排程沒有啟用。

**容量** 只用常數成本的來源：每個 table 的最大 rowid（列數估計，刪除後會偏高）、D1 查詢回傳的資料庫大小，以及最近一次比對累計的 R2 大小。需要精確列數時才使用 `GET /api/health/data?exact=1`，它會對每個 table 做 `COUNT(*)`。

其他階段新增的 table（例如背景整理或筆記標記）先查 `sqlite_master` 才讀；不存在時顯示 `available:false`，欄位不同時顯示 `error:"query_failed"`，不影響其他項目。

## 備份

### 一個 checkpoint 包含什麼

1. **原文複本**：每個已穩定（收到超過 10 分鐘）的批次只複製一次到 `BACKUP` 的 `raw/<原本的 key>`，寫入時附上 SHA-256 讓 R2 驗證；複製紀錄在 D1 `backup_raw_objects`，所有 checkpoint 共用。複製時找不到原文的批次記為 `source_missing`，之後每次排程依「最久沒檢查」的順序再找最多 50 個；裝置重送同一批次（內容相同、key 相同）或原文被放回後，就會補上複本，下一個 checkpoint 便能完整還原。
2. **分輪匯出**：每輪寫成 `checkpoints/<id>/d1/<序號>.ndjson`，位置以 compare-and-swap 推進，checkpoint 有租約，重疊的排程不會重複寫。依序是：
   - `batches`、`events`、`event_versions`：依（收到時間, ID）順序，每輪 100 個已穩定的批次，連同它們自己的事件與版本。
   - **帳本**：會隨活動增長、而且 trigger 禁止任何修改與刪除的 table（`context_sources`、`context_audit`、`context_generation`、`context_flag_audit`、`context_share_audit`、`processing_job_sources`、`processing_coverage`、`processing_signals`、`processing_job_audit`、`retention_runs`，以及 policy、budget、訂閱的稽核表），依 rowid 每輪最多 1,000 列。
   - **會改變的 table**：會隨活動增長、資料列之後還會改變的 `sessions`、`processing_jobs`、`processing_calls`、`context_entries`（每輪 200 列）、`context_flags`（每輪 500 列）、`retention_run_objects`，同樣依 rowid 分輪匯出。

   分類寫在 `src/operations-shared.ts`，每個 migration 建立的 table 都要分類，否則測試失敗；帳本必須真的有禁止修改與刪除的 trigger。
3. **最終快照**：在**同一個 D1 transaction** 裡讀取：小型參照表（裝置、專案、任務與連結、群組與關係、policy 與 budget、訂閱、共享）全部；每個分輪 table 在最後一輪之後新增的尾端；以及會改變的 table 中，可能在它那一輪之後改變的資料列（**重讀**）。其他階段新增、尚未分類的 table 也整個放在這裡。備份自身的帳務 table（`backup_*`、`health_state`）不放進快照，它們描述的是 BACKUP 本身。
4. **原文清單**：原文複製追上這次匯出的所有批次後，寫出這個 checkpoint 涵蓋的原文清單 `checkpoints/<id>/raw/<序號>.ndjson`。
5. **manifest**：`checkpoints/<id>/manifest.json` 列出每個分塊的 key、SHA-256、大小與各 table 列數。

**為什麼仍然外鍵封閉**：checkpoint 執行期間不會刪除任何資料列（保存期限在 checkpoint 執行時一律拒絕套用，其他 table 不是有禁止刪除的 trigger，就是沒有任何刪除的程式路徑）；新的資料列一定落在已匯出的位置之後（批次依收到時間並先等待 10 分鐘穩定，其他 table 依 rowid——沒有刪除時，SQLite 給新資料列的 rowid 一定大於現有最大值）；最終快照又讀取每個分輪 table 位置之後的尾端。所以每個 table 匯出的資料列集合，恰好就是最終快照那一刻的資料列集合，而 D1 在每次寫入時都強制外鍵，備份因此外鍵封閉。帳本的資料列不會改變，內容也與那一刻相同；會改變的 table 由**重讀**補上：重讀該 table 第一輪開始前 1 小時（容許排程時鐘落後）以後有改動紀錄、而且已在某一輪匯出的資料列——筆記看 `reviewed_at` 與被它取代的上一版、工作看 `updated_at`、外部呼叫看 `finished_at`、標記看 `resolved_at`、刪除紀錄看兩個刪除時間、session 看之後收到的批次。這些 table 的每一種更新都會寫入對應欄位；還原時重讀的資料列依主鍵取代較早一輪的同一列，manifest 另外記錄每個分塊的重讀列數，所以列數仍然精確。

只有 `events.project_id` 仍可能與快照時不同（同一 session 之後補上 repo 時，ingest 會升級整個 session 的專案）；還原檢查把它列為 `event_project_drift` 發現，不算失敗。這個模型假設 ingest 在收到後 10 分鐘內提交，並假設 checkpoint 期間 rowid 不會被重新編號（只有 `VACUUM` 會這樣做，本服務從不執行它）；萬一發生，還原檢查會以 `row_load_failed`、`revision_without_row` 或列數不符失敗，而不是悄悄通過。D1 Time Travel 仍是時間點回復的機制；這份備份用來證明可以在別處重建資料，並保存 R2 原文。

上限：最終快照讀取前，先以常數成本取得每個查詢的上限（`MAX(rowid)` 與有上限的計數），所有查詢的 `LIMIT` 加總不超過 60,000 列，另有 24 MiB 的大小上限，所以不會一次把超過預算的資料讀進記憶體。批次尾端超過 200 個、或某個分輪 table 的尾端超過 1,000 列時，先多做一輪再拍快照；最近 10 分鐘內收到的批次太多時，等下一次排程。某個 table 的重讀超過 10,000 列，或小型參照表加上重讀超過 60,000 列時，checkpoint 以 `final_snapshot_too_large` 失敗，需要調整分類或上限，不會靜默截斷。

**完整性檢查**：checkpoint 完成後，`backup` 任務分次重新讀取並雜湊 manifest 與這個 checkpoint 的每個分塊（含原文清單），並以大小和 R2 保存的 SHA-256 核對清單中**還沒驗證過**的原文複本；通過後寫入 `integrity_verified_at`，失敗則記錄 `manifest_missing`、`manifest_mismatch`、`chunk_missing`、`chunk_mismatch`、`raw_missing` 或 `raw_mismatch`。

- 原文複本以內容定址、所有 checkpoint 共用，所以每個複本只驗證一次（`backup_raw_objects.verified_at`，重新寫入時清除）。之後的 checkpoint 只檢查新複本，每次的工作量跟新批次數量成正比，不會隨歷史總量增加。代價是：驗證過的複本之後若在 BACKUP 裡被改動，完整性檢查不會再發現；保存期限套用前仍會逐一確認複本的大小與 SHA-256，還原演練也會重新下載並雜湊每個複本。
- 一律先檢查**最新**完成、尚未通過的 checkpoint，因為保存期限只依靠 `BACKUP_MAX_AGE_DAYS` 內最新的已驗證 checkpoint；較舊的會在之後輪到。
- 每次排程先把剩餘配額與時間的 40% 留給完整性檢查，再推進進行中的 checkpoint，最後把剩下的再給完整性檢查，所以大型 checkpoint 的分塊工作不會讓它永遠排不到。

### 審閱者操作

備份含裝置金鑰雜湊，所以**連查看都需要 `REVIEW_TOKEN`**；`READ_TOKEN`、Access、MCP 與裝置金鑰都會被拒絕。

```text
GET  /api/backups?limit=20&before=CURSOR
GET  /api/backups/REPLACE_WITH_CHECKPOINT_UUID
GET  /api/backups/REPLACE_WITH_CHECKPOINT_UUID/object?key=REPLACE_WITH_MANIFEST_KEY
POST /api/backups/run                                  {}
POST /api/backups/REPLACE_WITH_CHECKPOINT_UUID/verify  （restore-check 輸出的 verify_request）
POST /api/backups/REPLACE_WITH_CHECKPOINT_UUID/expire  {}
```

- `object` 只提供該 checkpoint manifest 確實列出的 key（manifest、分塊、清單中的原文複本），一律以 `application/octet-stream` 和 `Content-Disposition: attachment` 回傳。被 forwarder 重送回來、又重新複製的批次，較早的 checkpoint 仍以它當時列出的那一份複本判斷成員資格，所以寬限期內仍能演練。
- `run` 只建立 checkpoint，實際工作仍由每小時的 `backup` 任務推進；沒有啟用任務時，它會停在「進行中」。同時只能有一個進行中的 checkpoint。
- `verify` 記錄還原演練結果。伺服器只能比對回報的列數與 manifest 是否一致；**「已驗證」是審閱者對演練的證明，不是伺服器能檢查的證據**。
- `expire` 刪除該 checkpoint 的資料庫匯出檔並標記為到期（不可復原）。它拒絕最新的已驗證 checkpoint，以及寬限期內有保存期限執行依靠的 checkpoint。原文複本由所有 checkpoint 共用，不因到期而刪除。

## 還原演練（restore-check）

`scripts/restore-check.ts` 只在它自己建立的本機 Miniflare D1／R2 上操作，從不連線到遠端資料庫、不讀 Wrangler config，也不會在 `migrations/` 新增檔案。

```sh
cd workers/beacon-cloud
umask 077
# 審閱金鑰放在絕對路徑、權限 0600 的一般檔案（不能是 symlink）；指令與輸出不會顯示它
npm run backup:restore-check -- --url https://REPLACE_WITH_TEST_WORKER --review-token-file /ABS/PATH/review-token --checkpoint REPLACE_WITH_CHECKPOINT_UUID
# 想保留下載的物件做離線演練時，加上一個不存在或空的絕對路徑：--out /ABS/PATH/new-directory
npm run backup:restore-check -- --dir /ABS/PATH/new-directory --checkpoint REPLACE_WITH_CHECKPOINT_UUID
```

流程：

1. 先從伺服器取得 manifest 的 SHA-256，下載並核對 manifest；每個 key 都必須符合固定格式，檔案以 key 的 SHA-256 命名存在私人暫存目錄，不使用 key 當路徑。不使用 `--out` 時，結束後刪除暫存目錄。
2. 下載並核對每個分塊與原文複本的大小與 SHA-256。不跟隨 redirect。
3. 在新的 Miniflare D1 套用所有 migration，但**先略過 `CREATE TRIGGER`**；依 `PRAGMA foreign_key_list` 推出的外鍵順序載入資料（同 table 的版本鏈先載入前一版；最終快照重讀的資料列依主鍵取代較早一輪匯出的同一列，找不到那一列時記為 `revision_without_row`），再用同一份 migration 文字建立 trigger，並比對 `sqlite_master` 保存的 trigger SQL 與原文完全一致。任何一個 table 無法載入（例如主鍵重複，或某列指向不存在的父列：暫存 D1 在載入時就強制外鍵）記為 `row_load_failed`，之後依賴它的檢查也會跟著失敗。這是唯一的載入方式，只用在這個暫存資料庫。
4. 檢查：`PRAGMA foreign_key_check` 為空、各 table 列數與 manifest 相同、筆記審閱狀態欄位一致、每份已審閱筆記都有 `review_id` 對應的稽核、每份被取代的筆記都有已核准的新版與 `:supersede` 稽核、密封筆記有 1–20 個來源、裝置數與 token 雜湊數一致，以及**每個事件版本都能從原文那一行重新算出 `payload_hash`**。

輸出是 `{report, report_sha256, verify_request}`，只有數量、錯誤碼和雜湊。`result` 為 `passed` 時，把 `verify_request` 原樣送到 `POST /api/backups/:id/verify`，或貼到 dashboard 的「記錄還原演練結果」。常見失敗碼：`manifest_sha256_mismatch`、`chunk_sha256_mismatch`、`raw_sha256_mismatch`、`invalid_manifest_key`、`unknown_table`（備份含有本機 migration 沒有的 table）、`foreign_key_violation`、`trigger_mismatch`、`raw_not_in_manifest`、`payload_hash_mismatch`、`revision_without_row`、`row_load_failed`。

這是演練，不是正式回復。真正需要回復時，D1 仍以 Time Travel 或匯出檔處理；R2 原文可從 `BACKUP` 的 `raw/` 複本以同一個 key 放回 RAW。兩者都要先另行規劃並停止寫入。

## 保存期限

每個資料類別可以設定保存天數（`keep_days`，空白代表永久保存），每次變更都有不可修改的稽核：

```text
GET  /api/retention/policies
POST /api/retention/policies   {"data_class":"raw","keep_days":180}
GET  /api/retention/plan?max_batches=50&after=CURSOR
POST /api/retention/apply      （plan 回傳的 data_class、generated_at、cutoff、batch_ids、plan_sha256）
```

只有 `raw`（原始事件）會實際刪除。`summary`、`candidate`、`audit` 受第一階段的不可變 trigger 保護，期限只會記錄，API 一律回傳 `enforced:false`。

### 一個批次何時可以刪除

刪除的單位是整個上傳批次：它的 R2 原文、版本與事件索引一起刪除；session、專案、任務與筆記保留。產生計畫時，從收到時間早於 `現在 − keep_days` 的最舊批次開始，依（收到時間, ID）往後檢查，計畫最多選 50 個：

- 有筆記引用的批次永遠不能刪除（`context_sources` 不會消失），查詢時就直接略過並計入 `referenced_by_context`，不再逐一評估，所以它們堆在最舊的一端也不會卡住計畫。這類批次只會顯示這一個原因。
- 其餘批次每頁最多評估 500 個（每頁最多往後走 5,000 個批次），一次請求最多 3 頁，找到足夠的可刪批次就停。跨頁時一起檢查事件版本的封閉性。
- 還沒走完早於截止時間的批次時，回應的 `scan_limited` 為 `true`，`next_after` 是下一次的起點；把它傳給 `GET /api/retention/plan?after=...` 就從那裡繼續。`scanned` 是走過的批次數，`assessed` 是實際評估的數量。

下列任一情況會擋下：

| 原因 | 意思 |
| --- | --- |
| `no_verified_backup` | 沒有已複製的原文備份，或批次不是在一個「已演練驗證＋完整性檢查通過、`BACKUP_MAX_AGE_DAYS` 內」的 checkpoint 最終快照前 10 分鐘以上收到 |
| `shared_event_versions` | 這個批次的事件在計畫外的批次還有其他版本；事件索引存在第一次收到的批次，必須一起刪除 |
| `referenced_by_context` | 有筆記（任何狀態）引用其中的事件版本 |
| `referenced_by_processing` | 背景整理的佇列、執行中或失敗工作使用其中的版本（table 存在時） |
| `referenced_by_flag` | 未處理的筆記標記以其中的版本為證據（table 存在時） |
| `within_keep_days` | 仍在保存期限內 |
| `class_report_only` | 這個類別只記錄期限 |

讀不到上述其他階段的 table 時，計畫回傳 `503`，不會把「讀不到」當成「沒有引用」。計畫的 `plan_sha256` 綁定產生時間、截止時間與批次清單，**1 小時內有效**。套用時伺服器重新計算雜湊、以計畫自己的截止時間重新檢查每個批次、確認保存期限沒有變長、確認沒有進行中的備份，並逐一確認 BACKUP 裡的複本仍在且大小與 SHA-256 相符；任何一項不符就整份拒絕（`409`），請重新產生計畫。

通過後，在**同一個 D1 transaction** 內再確認一次：沒有進行中的備份、依靠的 checkpoint 仍有效、批次都還在、沒有新的引用、事件版本沒有落在計畫外，然後依序刪除版本、事件、批次，並寫下 `retention_runs` 與每個 key 的 `retention_run_objects`；之後才刪 R2 原文。R2 刪除失敗時索引已經刪除，該 key 會在資料健康顯示為 `retention_raw_delete_pending`，由 `backup` 任務重試。

### 原文實際保存多久

- 主要 R2 的原文在套用時刪除；BACKUP 中的複本再保留 `BACKUP_RETENTION_GRACE_DAYS`，之後由 `backup` 任務刪除並記錄。**原文最長保存期間是 `keep_days` 加上寬限天數。**
- 刪除複本時，凡是原文清單列過這個複本的 checkpoint（包括批次被重送、重新複製之前那一份）都會標記 `raw_pruned_at`：它們不再能完整還原那些批次，也不再能作為保存期限的依據。這些舊 checkpoint 的資料庫匯出檔仍含有被刪批次的索引列（不含原文），請用 `expire` 讓它們到期。
- Cloudflare D1 Time Travel 本身也保留一段時間的歷史，不受這裡的設定控制。
- **forwarder 重送仍保留在 Mac 本機的紀錄時，會把已刪除的批次重新上傳回來**（批次內容相同時會得到相同的批次 ID）。ingest 刻意不讀保存期限的資料，因此不會拒收。資料健康會把同時出現在 `batches` 與刪除紀錄中的批次回報為 `resurrected_batch`；它的原文與備份複本不會被重試刪除，`backup` 任務也會把它重新複製一次。需要時重新產生並套用計畫，並調整本機保留或 forwarder 的起點。再次刪除時，BACKUP 複本只依**最新一次**刪除的寬限期移除，較早那次刪除的期限不再作數。

## 回復與限制

`0006`、`0008`、`0009` 只新增 table、欄位、index 與 trigger，沒有 down migration。只需要退版程式時，回復上一個 Worker 版本即可，新 table 保留不動；不要 drop table、刪除稽核或清掉 BACKUP 來退版。

尚未提供或尚未驗收：雲端上的實際備份與還原演練、摘要／候選／稽核的實際刪除、多人具名審閱、BACKUP bucket 本身的生命週期設定。所有數字與流程都只經過本機合成測試。
