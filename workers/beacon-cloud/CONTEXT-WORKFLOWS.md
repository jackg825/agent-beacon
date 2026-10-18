# 專案關聯、交接筆記與 memory 審閱

這一階段讓兩台 Mac 的活動可以被人工串成任務，並保存有來源的交接摘要與 memory。它目前是**手動整理與審閱流程**，沒有 Jev、自動 AI compact、檔案發布或跨 Mac memory 同步。

新增功能的本機合成驗證與整體檢查結果見 [VALIDATION.md](VALIDATION.md)。先前 [TEST-DEPLOYMENT.md](TEST-DEPLOYMENT.md) 記錄的是基礎 ingest／dashboard／MCP 的雲端驗收，不能當成這一階段已部署或真實兩台 Mac 已接上的證據。

## 日常使用方式

1. 在「活動紀錄」查看裝置、專案與 session。原本的 collector 和轉送設定不需要因為這項功能改動。
2. 在「專案關聯」建立產品群組，例如把網站、API、SDK 放進同一群組；再明確標示依賴、共用服務或 fork 關係。
3. 建立任務，例如「修復登入」，把 MBP 的修復 session 和 Mac mini 的測試 session 加到同一任務。
4. 在時間線勾選事件作為筆記來源，切換 session 後仍可繼續選；在「交接與記憶」填寫內容，送交審閱。
5. 查看候選的每個原始來源、指定版本與審閱紀錄，再核准或拒絕。核准只代表人工採用，並不代表系統已證明內容正確。
6. MCP 可以讀取任務、已核准內容與原始版本；沒有寫入、核准、發布或改動 Mac 設定的工具。

專案群組不會合併 repo，任務也不會合併 session。兩台裝置的事件仍保留自己的身分。專案群組及關聯只是查詢與整理用途，目前整個服務仍是單一私人工作區，不是各專案獨立的權限系統。

三種專案關係都是有方向的明確設定：

| 類型 | 意思 | 例子 |
| --- | --- | --- |
| `depends_on` | 來源專案依賴目標專案 | 網站 → API |
| `shares_service` | 記錄來源與目標專案共用服務的關係 | 網站 → 後台 |
| `fork_of` | 來源專案是目標專案的 fork | 私人 fork → 官方 repo |

它們不會自動被 AI 推論，也不會把共用服務名稱或網址當成存取權限。群組、關係與 task 連結目前提供新增操作，沒有移除、改名或批次清理介面。

## 一份筆記的範圍與生命週期

`summary` 是交接摘要；`memory` 是供後續查詢採用的知識筆記。兩者都儲存在中央 D1，原始事件仍在 R2。核准 memory **不會**自動寫入任何 Mac 的 `AGENTS.md`、skills 或其他記憶檔案。

一份候選只屬於一個專案，可以另外指定 task。所有來源都必須屬於該專案；若指定 task，來源事件所在的 session 也必須已連結到該 task。Task 可以跨專案，但跨專案交接應各寫一份專案筆記，再用同一 task 串起來。

| 狀態 | 可以怎麼使用 |
| --- | --- |
| `pending` | 待審候選，不當成已採用知識 |
| `approved` | 已核准；還要確認 `authoritative=true` |
| `rejected` | 已拒絕，留下內容、來源與理由供回查 |
| `superseded` | 已被核准的新版本取代，保留歷史 |

候選的內容與來源不能直接修改。要修正已核准內容，建立新候選並設定 `supersedes_id`：新候選待審時，舊版仍有效；拒絕新版不會動到舊版；核准新版時，舊版才在同一個資料庫操作中改成 `superseded`。兩份修訂競爭取代同一版，只有一份可以核准，另一份收到 `409`。

每次來源都指定「中央事件 ID＋`payload_hash`」，不猜版本，也不偷偷換成第一份 payload。建立候選及核准時，服務讀取指定的 R2 原文、核對雜湊，並確認原文的專案／session／harness 範圍與中央索引一致。相同事件 ID 的另一份 capture 若聲稱不同 repo 或 session，不能用來取得錯誤的來源背書。

`sources_valid` 只表示目前 D1 中的專案／task 範圍仍符合，不表示 R2 永遠可讀，也不表示摘要每一句都是真的。來源範圍之後變動，已核准筆記會變成 `authoritative=false`；預設查詢不再回傳它。明確指定 `status=approved` 仍可查看這些紀錄供稽核。原文缺失或損壞時，建立／核准回傳 `503`，不把它當成成功；仍可以拒絕待審候選。

## 金鑰與審閱紀錄

查閱沿用讀取權限；新增群組、關聯、任務、候選及審閱，都需要獨立的 `REVIEW_TOKEN`。裝置金鑰、`READ_TOKEN`、`MCP_TOKEN` 都不能取得寫入權限；與其他角色重用相同金鑰時也會拒絕。

使用至少 32 字元的獨立高熵隨機金鑰，正式值放在 Cloudflare Secrets；本機放在被忽略的 `.dev.vars`。不要放入 Wrangler `vars`、筆記、範例 JSON、網址或公開 repo。Dashboard 只在目前頁面暫存輸入的審閱金鑰，不寫入 `localStorage`、`sessionStorage` 或網址；可按「清除金鑰」，頁面離開時也會清除。這不是把金鑰藏進前端程式。

目前審閱紀錄的 actor 是 `reviewer:` 加上審閱金鑰雜湊的部分識別值。它代表「使用這組工作區審閱憑證」，**不能證明是哪一位具名使用者**。需要多人責任歸屬時，應先加入具名登入與權限流程，再宣稱可追溯到個人。

## API 範例與限制

下列全是 placeholder，ID 必須改用實際查詢回傳值；不要把私人事件內容或真正金鑰貼進公開文件。GET 使用讀取權限，POST 使用獨立審閱權限。所有 POST 都要求 `Content-Type: application/json`，整份 UTF-8 request 上限 64 KiB，拒絕多餘欄位與壓縮本文。

先建立群組與任務：

```text
POST /api/project-groups
{"name":"產品 A"}

POST /api/project-groups/REPLACE_WITH_GROUP_UUID/members
{"project_id":"REPLACE_WITH_CENTRAL_PROJECT_SHA256"}

POST /api/project-relations
{"from_project_id":"REPLACE_WITH_SOURCE_PROJECT_SHA256","to_project_id":"REPLACE_WITH_TARGET_PROJECT_SHA256","type":"depends_on"}

POST /api/tasks
{"title":"修復登入與跨機驗證"}

POST /api/tasks/REPLACE_WITH_TASK_UUID/sessions
{"session_id":"REPLACE_WITH_CENTRAL_SESSION_SHA256"}

POST /api/tasks/REPLACE_WITH_TASK_UUID/status
{"status":"completed"}
```

群組成員、task session 與同型關係重送時不重複新增。建立群組、task 或候選不是通用冪等 API；若送出後連線中斷，先查詢是否已存在，不要盲目重送建立多份內容。

建立有來源的候選：

```json
{
  "kind": "summary",
  "project_id": "REPLACE_WITH_CENTRAL_PROJECT_SHA256",
  "task_id": "REPLACE_WITH_TASK_UUID",
  "title": "登入修復交接",
  "content": "合成範例：已調整 callback；本機測試通過，真實登入仍待驗證。",
  "sources": [
    {
      "event_id": "REPLACE_WITH_CENTRAL_EVENT_SHA256",
      "payload_hash": "REPLACE_WITH_EXACT_PAYLOAD_SHA256"
    }
  ]
}
```

送到 `POST /api/context`，回傳 `201` 與 `{context: ...}`。不要使用原始 collector 的 `event.id` 代替中央事件 ID；應使用時間線回傳的 `id`。`task_id` 可省略；修訂時另外加 `supersedes_id`，且必須指向同 kind／專案／task 範圍的目前已核准版本。

核准或拒絕：

```text
POST /api/context/REPLACE_WITH_CONTEXT_UUID/review
{"decision":"approve","reason":"已核對指定來源與待驗證事項。"}

POST /api/context/REPLACE_WITH_CONTEXT_UUID/review
{"decision":"reject","reason":"內容超出來源能支持的範圍。"}
```

同一候選只能有一次終局審閱。重送、過時修訂或競爭失敗回傳 `409`；應重新查閱狀態，不能把該錯誤當成這次操作成功。核准／拒絕與相關稽核紀錄同時提交，不會只改狀態而遺漏稽核。

查詢使用以下 GET；需分頁的清單回傳 `next_cursor`，下一頁以 `before` 傳回該 opaque 值，`limit` 為 1–40：

```text
/api/project-groups
/api/project-groups/REPLACE_WITH_GROUP_UUID
/api/project-relations?project_id=REPLACE_WITH_CENTRAL_PROJECT_SHA256
/api/tasks?status=open
/api/tasks/REPLACE_WITH_TASK_UUID
/api/sessions?project_group_id=REPLACE_WITH_GROUP_UUID
/api/sessions?task_id=REPLACE_WITH_TASK_UUID
/api/context?project_id=REPLACE_WITH_CENTRAL_PROJECT_SHA256
/api/context?task_id=REPLACE_WITH_TASK_UUID&kind=memory&status=pending
/api/context/REPLACE_WITH_CONTEXT_UUID
/api/events/REPLACE_WITH_CENTRAL_EVENT_SHA256?payload_hash=REPLACE_WITH_EXACT_PAYLOAD_SHA256
/api/events/REPLACE_WITH_CENTRAL_EVENT_SHA256/versions
```

Context 清單的狀態預設為已核准且 D1 來源範圍有效；明確指定其他狀態可查待審與歷史。Detail 回傳內容、來源與稽核，必須檢查 `status`、`sources_valid` 及 `authoritative`。清單不附來源全文，詳情的 source 引用也不是原文；使用 exact event API／MCP 工具讀取指定版本。

| 項目 | 限制 |
| --- | --- |
| 群組名稱／task 標題 | 160／240 字元 |
| 筆記標題／內容 | 160／12,000 字元；仍受整份 request 64 KiB 限制 |
| 來源 | 1–20 個不重複 event／hash 配對 |
| 審閱理由 | 最多 2,000 字元，可省略 |
| Context／task／group ID | UUID |
| 專案／session／中央事件／payload hash | 64 位小寫十六進位識別值 |

## 升級既有 TEST 與回復

以下是待執行的 runbook，本文件沒有替雲端部署或還原作業提供驗收證據。正式 production 仍依 [DEPLOYMENT.md](DEPLOYMENT.md) 的授權與隔離流程；不要把本機通過當成 production 完成。

升級前，唯讀確認 `.local/wrangler.test.jsonc` 指向既有的 `agent-beacon-cloud-test`、`agent-beacon-cloud-test-db`、`agent-beacon-cloud-test-raw` 和正確 account；不要使用公開 Wrangler 檔案裡的 placeholder 或其他專案 config。保持沒有共用 route／DNS／Access 設定變更，RAW 保持私人。所有下面的 remote 命令都要保留相同的明確 `--config`。

先暫停本專案的測試轉送／管理寫入，保留 outbox。將私有備份目錄限制為目前使用者可讀寫，匯出完整 D1、私下記錄 schema／trigger、資料計數和當前 Worker 版本；在 account 支援時保存 Time Travel bookmark：

```sh
cd workers/beacon-cloud
umask 077
mkdir -p .local/backups
npx wrangler d1 export agent-beacon-cloud-test-db --remote --config .local/wrangler.test.jsonc --output .local/backups/REPLACE_WITH_BACKUP_NAME.sql
npx wrangler d1 time-travel info agent-beacon-cloud-test-db --config .local/wrangler.test.jsonc --json > .local/backups/REPLACE_WITH_BOOKMARK_NAME.json
```

備份可能包含私人內容與裝置 token digest，不能提交或貼進 logs。D1 備份不是 R2 原文備份。先在**獨立本機還原目錄**驗證匯出檔：使用下面的 `.local/wrangler.restore-check.jsonc`，零值 UUID 是本機 placeholder，不是遠端資料庫 ID。不要填入任何既有 account／D1 ID，不要部署這個 config，也不要把下面命令改成 `--remote`。

```json
{
  "name": "agent-beacon-restore-check-local",
  "main": "../src/index.ts",
  "compatibility_date": "2026-10-01",
  "workers_dev": false,
  "preview_urls": false,
  "d1_databases": [{
    "binding": "DB",
    "database_name": "agent-beacon-restore-check-local",
    "database_id": "00000000-0000-0000-0000-000000000000",
    "migrations_dir": "../migrations"
  }],
  "r2_buckets": [{"binding":"RAW","bucket_name":"agent-beacon-restore-check-raw"}]
}
```

```sh
npx wrangler d1 execute agent-beacon-restore-check-local --local --persist-to .local/restore-check --config .local/wrangler.restore-check.jsonc --file .local/backups/REPLACE_WITH_BACKUP_NAME.sql
```

核對還原後的 tables、constraints、trigger、資料計數及既有索引查詢；若 trigger／schema 不完整，先修復備份流程，不能繼續升級。這個本機 drill 不證明 R2 已還原，也不代表雲端 Time Travel 已演練成功。

確認備份可用後，在隔離 TEST 套用 migration `0002_project_workflows.sql` 和 `0003_context_reviews.sql`，再部署新程式並透過互動提示設定獨立審閱 secret：

```sh
npx wrangler d1 migrations apply agent-beacon-cloud-test-db --remote --config .local/wrangler.test.jsonc
npx wrangler deploy --config .local/wrangler.test.jsonc
npx wrangler secret put REVIEW_TOKEN --config .local/wrangler.test.jsonc
```

Secrets 不寫到命令參數或 `vars`。沒有 REVIEW_TOKEN 時新增／審閱保持拒絕，查閱使用原本讀取權限。用合成事件重做關聯、task、候選、來源錯配拒絕、核准／修訂競爭、dashboard／唯讀 MCP，以及重新部署後的同一筆資料查詢；驗收前不接真實 transcript。

若只是程式退版，回復上一個已核准 Worker 版本，保留所有新增 D1 tables 和 R2：

```sh
npx wrangler rollback REPLACE_WITH_PREVIOUS_WORKER_VERSION_ID --config .local/wrangler.test.jsonc
```

兩份 migration 是 additive，沒有 down migration；不要 drop tables、刪除候選、移除 audit 或清掉 R2 來退版。舊程式可繼續使用原有 tables，新增資料保留供修復後讀取。

若確實需要 D1 回到較早時間，這是另一項會丟棄新索引、審閱或裝置輪替的回復操作。停止本專案寫入、另存目前資料並確認還原時間後，才使用明確 TEST config 的 Time Travel restore；不要對共用 account 其他資料庫操作：

```sh
npx wrangler d1 time-travel restore agent-beacon-cloud-test-db --bookmark REPLACE_WITH_CONFIRMED_BOOKMARK --config .local/wrangler.test.jsonc
```

還原時點若早於 `0002`／`0003`，先使用舊 Worker，再規劃重新升級。D1 Time Travel 不回復 R2 原文或本機 outbox；對齊裝置 token 狀態、D1 index、保留的 R2 batches 與 checkpoint 後才恢復轉送。自動 reindex、scheduled backup 和真正雲端 restore 演練仍未完成。
