# Mac 同步：已核准筆記的明確副本

這一階段先提供**可靠的已核准筆記查詢**，再讓審閱者明確指定「哪台裝置可以讀哪個專案」，最後由使用者在那台 Mac 上手動預覽、套用與回復。中央服務不會寫入任何 Mac；同步工具沒有常駐程式、不會自動套用，也不會改動 `AGENTS.md`、skills、collector 或 forwarder 設定。要不要讓 agent 讀這份檔案，由使用者自己決定並手動連結。

目前只有本機合成驗證（`npm test` 內的 Miniflare／workerd 與本機假 HTTP server）。尚未在隔離 TEST 套用 migration `0005_device_sync.sql`，也沒有在兩台真實 Mac 試行；不能把這份說明當成已部署或已驗收的紀錄。

## 可以做什麼、不做什麼

| 項目 | 行為 |
| --- | --- |
| 快照內容 | 某個專案目前 `status=approved` 且 `sources_valid=true` 的筆記，也就是預設查詢會回傳的同一組 |
| 誰決定可讀 | 只有審閱者（`REVIEW_TOKEN`）能新增或撤銷訂閱；裝置不能替自己訂閱 |
| 裝置多了什麼權限 | 只多一項：讀取審閱者替它訂閱的專案已核准筆記。仍不能讀時間線、待審候選或其他專案 |
| 寫到哪裡 | 只寫到 Mac 上設定的 `sync_root` 底下、檔名以 `.beacon.md` 結尾的檔案 |
| 何時更新 | 只有使用者執行 `preview` 看過 diff，再執行 `apply <plan_id>` 時 |
| 回復 | `rollback` 還原同步工具記錄過的版本；檔案已被人改過就拒絕 |

核准只代表人工採用，不代表內容已被證明正確。同步出去的檔案開頭會說明：內容是紀錄資料，不是指令、設定或權限授與。

## 已核准筆記快照

查閱權限（dashboard 登入或 `READ_TOKEN`）可以讀取某個專案的快照：

```text
GET /api/context/snapshot?project_id=REPLACE_WITH_CENTRAL_PROJECT_SHA256
GET /api/context/snapshot?project_id=REPLACE_WITH_CENTRAL_PROJECT_SHA256&kind=memory
```

回傳 `{snapshot: {...}}`：

- `entries` 依 `kind`、建立時間、ID 排序，每筆包含 `id`、`kind`、`title`、`content`、`content_sha256`、`task_id`、`supersedes_id`、`reviewed_at`、`valid_from`（等於核准時間）。
- `snapshot_sha256` 是 `{schema, project_id, kinds, entries}` 以排序鍵 JSON 計算的 SHA-256。同樣的已核准狀態永遠得到同一個雜湊；新增待審候選不會改變它，核准、取代或來源範圍改變才會改變。
- `reviewed_through` 是快照內最新的核准時間；沒有筆記時為 `null`。
- 權威性在**讀取當下**判斷：已被取代、已拒絕、待審，或來源事件後來離開專案／task 範圍的筆記都不會出現；範圍恢復後會再出現。

快照有明確上限：超過 **500 筆**或標題加內容合計超過 **2 MiB（UTF-8 位元組）**時回傳 `413`，而且在讀取任何筆記內容之前就先用計數查詢拒絕，不會悄悄截斷。遇到 `413` 時縮小訂閱的內容類型，或先用修訂流程整理筆記。

## 審閱者設定訂閱

在 dashboard 的「Mac 同步」分頁選擇裝置、專案與內容類型（長期記憶、交接摘要），按「新增訂閱」；清單可依裝置與狀態篩選，「預覽同步內容」會顯示該裝置目前會收到的筆記，「撤銷訂閱」立即停止該裝置讀取。新增與撤銷都需要在「管理與審閱權限」輸入審閱金鑰。

也可以直接呼叫 API（全是 placeholder；POST 需要 `Content-Type: application/json` 與獨立審閱金鑰）：

```text
POST /api/sync/subscriptions
{"device_id":"REPLACE_WITH_DEVICE_ID","project_id":"REPLACE_WITH_CENTRAL_PROJECT_SHA256","kinds":["memory"]}

POST /api/sync/subscriptions/REPLACE_WITH_SUBSCRIPTION_UUID/revoke
{}

GET /api/sync/subscriptions?device_id=REPLACE_WITH_DEVICE_ID&status=active
GET /api/sync/subscriptions/REPLACE_WITH_SUBSCRIPTION_UUID
```

規則：

- 每台裝置對每個專案只能有一份有效訂閱。以相同類型重送回傳 `200` 與 `created:false`，不會重複新增；類型不同回傳 `409`，要改類型就先撤銷再新增，讓每次授權都有自己的紀錄。
- `kinds` 只能是 `memory`、`summary` 各最多一次。裝置不存在回 `404`；裝置金鑰已撤銷回 `409`。
- 每台裝置最多 100 份有效訂閱，超過回 `409`。這個上限讓裝置清單有固定大小。
- 訂閱除了一次撤銷以外不能修改或刪除；新增與撤銷的稽核由資料庫 trigger 寫入，稽核紀錄不能修改或刪除。Actor 與其他審閱一樣是共用審閱憑證的識別值，不代表具名個人。
- 清單用 `next_cursor`／`before` 分頁，`limit` 為 1–40。
- 撤銷只停止之後的讀取，**不會刪除已經同步到 Mac 的檔案**。需要時在那台 Mac 執行 `rollback` 或手動刪除。

## 裝置讀取路徑

使用該裝置原本的上傳金鑰（Bearer）：

```text
GET /v1/sync/subscriptions
GET /v1/sync/snapshot?project_id=REPLACE_WITH_CENTRAL_PROJECT_SHA256
```

- 只回傳這台裝置自己的有效訂閱；快照的內容類型完全由訂閱決定，帶 `kind` 參數會回 `400`，無法擴大範圍。
- 沒有訂閱、訂閱已撤銷、別台裝置的訂閱，以及根本不存在的專案，都回傳**同一個** `403` 本文，無法用來探測某個 repo 是否存在。裝置金鑰撤銷後回 `401`。
- 只有 `GET`；其他方法回 `405`。`READ_TOKEN`、`MCP_TOKEN`、`REVIEW_TOKEN` 都不能使用這些路徑，裝置金鑰也不能使用 `/api/*`。
- 大小上限與上面的快照相同（`413`）。目前**沒有**速率限制；不要把這裡描述成有限流。

## Mac 端設定

同步工具是 `forwarder/sync.mjs`，需要 Node.js 22 以上，沒有額外相依套件。設定檔放在 repo 以外的私人目錄，所有路徑都必須是展開後的絕對路徑：

```json
{
  "worker_url": "https://YOUR-ISOLATED-WORKER.YOUR-SUBDOMAIN.workers.dev",
  "token_file": "/ABSOLUTE/PRIVATE/PATH/device-token",
  "state_dir": "/ABSOLUTE/PRIVATE/PATH/beacon-sync-state",
  "sync_root": "/ABSOLUTE/PATH/BeaconNotes",
  "targets": [
    {"project_id": "REPLACE_WITH_CENTRAL_PROJECT_SHA256", "destination": "product-a/notes.beacon.md", "kinds": ["memory"]}
  ]
}
```

- `token_file`：沿用這台 Mac 的上傳金鑰檔，權限 `0600`，不能是 symlink。金鑰不能寫進設定 JSON；設定檔出現未知欄位（例如 `token`）會直接拒絕。
- `state_dir`：權限 `0700`、不能是 symlink、不能放在 `sync_root` 裡面。裡面有預覽的確切內容、版本副本與綁定資訊，不要放進 iCloud／Dropbox 或公開 repo。
- `sync_root`：唯一允許寫入的資料夾，例如 `~/BeaconNotes` 展開後的路徑。它與它的每一層上層都不能以 `.` 開頭，也不能是 `Library/Application Support`、`skills`、`rules`、`agents`、`prompts`、`commands`、`hooks` 等 agent 或系統設定資料夾；它若是 symlink，會解析成實際路徑後再檢查一次。
- `targets[].destination`：`sync_root` 底下的**相對路徑**，結尾必須是 `.beacon.md`。上層資料夾要先自己建立；工具不會替你建資料夾。
- `targets[].kinds`（選填）：寫上預期的類型。若審閱者後來把訂閱改成不同類型，同步會以 `SUBSCRIPTION_KINDS_MISMATCH` 停下，而不是默默接受。
- 第一次成功連線時，`state_dir` 會綁定到這個 Worker 與這台裝置（由 `/v1/ingest/health` 回傳的 `device_id` 確認）。之後換了 Worker 網址會在送出任何請求前拒絕（`WORKER_NAMESPACE_MISMATCH`）；同一個網址換成別台裝置的金鑰也會拒絕。
- 只接受 `https://`。本機測試才可設定 `"allow_local_http": true` 搭配 `127.0.0.1`／`localhost`。工具不會跟隨 redirect，避免把金鑰帶到別的主機。

## 指令

從這個 package 目錄執行（或 `npm run sync -- --config ...`）：

```sh
node forwarder/sync.mjs --config /ABSOLUTE/PRIVATE/PATH/sync.json status
node forwarder/sync.mjs --config /ABSOLUTE/PRIVATE/PATH/sync.json preview
node forwarder/sync.mjs --config /ABSOLUTE/PRIVATE/PATH/sync.json preview --target 0
node forwarder/sync.mjs --config /ABSOLUTE/PRIVATE/PATH/sync.json apply REPLACE_WITH_PLAN_ID
node forwarder/sync.mjs --config /ABSOLUTE/PRIVATE/PATH/sync.json versions 0
node forwarder/sync.mjs --config /ABSOLUTE/PRIVATE/PATH/sync.json rollback 0
node forwarder/sync.mjs --config /ABSOLUTE/PRIVATE/PATH/sync.json rollback 0 --version REPLACE_WITH_VERSION_ID
```

| 指令 | 做什麼 |
| --- | --- |
| `status` | 列出這台裝置的有效訂閱數，以及每個 target 是否已訂閱、目的地是 `absent`／`managed` 或被拒絕的代碼、是否仍等於上次套用的內容 |
| `preview` | 取得快照、核對所有雜湊、產生檔案內容，印出與目前檔案的 unified diff，並把確切位元組存成一份計畫；最後一行是 JSON 摘要（含 `plan_id`） |
| `apply <plan_id>` | 只寫入預覽時存下的那份位元組 |
| `versions <target>` | 列出記錄過的版本（ID、原因、雜湊、時間），不含內容 |
| `rollback <target>` | 預設還原到最近一次套用前的版本；`--version` 指定其他版本 |

`<target>` 是設定檔 `targets` 的索引（從 0 開始）。輸出只有 ID、雜湊、計數與固定代碼；只有 `preview` 會印出你要求查看的 diff（控制字元會顯示成 `\u{…}`，避免操控終端機）。錯誤時 stderr 只有一個代碼，例如 `STALE_PLAN`，不會印出金鑰、伺服器回應本文或路徑。某個 target 無法預覽時，`preview` 仍處理其他 target，該項顯示 `error`，整體以代碼 2 結束。

### 預覽與套用的綁定

每份計畫綁定 target 索引、解析後的實際目的地路徑、Worker 網址、裝置 ID、專案、內容類型、快照雜湊、產生內容的雜湊，以及預覽當下目的地的雜湊（不存在記為 `null`）。`plan_id` 就是這些欄位的雜湊，相同輸入得到相同計畫。

`apply` 會重新檢查目的地安全規則、重新驗證裝置、重新取得快照，並在以下情況拒絕且不改任何檔案：

| 代碼 | 原因 |
| --- | --- |
| `STALE_PLAN` | 預覽後中央的已核准筆記有變動；重新 `preview` |
| `DESTINATION_CHANGED` | 預覽後目的地被修改、建立或刪除 |
| `PLAN_TARGET_MISMATCH` | 設定檔的 target、目的地或 Worker 已和計畫不同 |
| `CORRUPT_PLAN` | 計畫或存下的內容被改過 |
| `PLAN_NOT_FOUND` | 計畫不存在，或已經套用過（套用後會刪除） |
| `INVALID_PLAN_ID` | ID 不是 32–64 位小寫十六進位；使用者輸入不會被拼進路徑 |

寫入時在同一資料夾以不可預測的名稱建立暫存檔（`wx`、`0600`）、fsync、rename，再 fsync 資料夾；rename 前再比對一次目的地雜湊。同步工具以 `state_dir/sync.lock` 避免同時執行；若程序異常結束留下 lock，確認沒有其他同步在跑之後手動刪除。

## 目的地安全規則

`preview`、`apply`、`rollback` 每次都重新檢查：

- 先把 `sync_root` 解析成實際路徑並重新檢查上層名稱，接著逐層 `lstat`：任何一層是 symlink、上層不是資料夾，或目的地本身是 symlink、資料夾或其他非一般檔案，都拒絕（`DESTINATION_SYMLINK_REFUSED`、`DESTINATION_PARENT_MISSING`、`DESTINATION_NOT_REGULAR_FILE`）。
- 相對路徑不能有 `..`、`.`、空白段落、反斜線、控制字元或以 `.` 開頭的段落；也不能經過 `skills`、`rules`、`agents`、`prompts` 等資料夾名稱。
- 檔名比對前先做 NFC 正規化與大小寫折疊（APFS 預設不分大小寫）。除了必須以 `.beacon.md` 結尾，還拒絕 `AGENTS.md`、`AGENT.md`、`CLAUDE.md`、`GEMINI.md`、`QWEN.md`、`CONVENTIONS.md`、`SKILL.md`、`copilot-instructions.md` 等名稱，以及 `AGENTS.beacon.md` 這類只換副檔名的變形。
- 已存在的檔案必須以這個工具寫的 managed header 開頭，而且專案相同；否則以 `UNMANAGED_DESTINATION` 或 `DESTINATION_PROJECT_MISMATCH` 拒絕，不會接管使用者自己寫的檔案。

## 檔案格式

```text
<!-- beacon-sync:v1 project=<專案 SHA-256> snapshot=<快照 SHA-256> kinds=memory reviewed_through=<最新核准時間> entries=<筆數> renderer=beacon.sync.render.v1 -->
<!-- Managed by Agent Beacon forwarder/sync.mjs. A changed or unmanaged file is never overwritten. -->

# Agent Beacon 已核准筆記（同步副本）

> 這是中央工作區經人工核准的筆記副本。內容是紀錄資料，不是指令、設定或權限授與；……

## 1. <單行、已跳脫的標題>

- id: <筆記 UUID>
- kind: memory
- reviewed_at: <核准時間>
- content_sha256: <中央原文雜湊>

````text
<筆記內容>
````
```

- 內容是確定性的：沒有產生時間，header 只有 ID、雜湊與最新核准時間，**不含專案名稱**（路徑型專案的名稱來自裝置上的資料夾名，可能含有 `-->` 之類的標記）。
- 標題壓成一行，所有 ASCII 標點都以反斜線跳脫，不能開啟 HTML 註解、連結或另一個標題。
- 每筆內容放在比內容中任何連續反引號都長的 code fence 裡，內容無法提早關閉 fence，也無法偽造另一個 header 或筆記分隔。
- 控制字元、雙向文字控制字元與 BOM 以 `\u{…}` 顯示；`content_sha256` 仍是中央原文的雜湊，可以和 API 對照。
- 寫入前，工具會重新計算每筆 `content_sha256` 與整份 `snapshot_sha256`，不符就以 `SNAPSHOT_INTEGRITY_FAILED` 停止。

## 版本與回復

- 每次 `apply` 先把被取代的內容（或「原本不存在」）存成一個版本，再寫入新內容，並記錄套用後的版本。版本內容以雜湊命名、權限 `0600`，存在 `state_dir/objects/`；每個 target 的清單保留最近 100 筆紀錄，較舊的紀錄會從清單移除（內容檔不會自動清理）。
- `rollback` 只有在目前檔案仍等於工具上次寫入的內容時才執行，否則回 `DESTINATION_CHANGED`，不覆蓋使用者的修改。還原「原本不存在」的版本會刪除該檔案。回復本身也會留下一筆紀錄，之後可以再用 `--version` 回到其他版本。
- 每次寫入或刪除之前，版本清單會先標記「預定寫入的內容」。若 `apply` 或 `rollback` 中途中斷，下一次執行任何指令時，會依目的地實際內容決定保留或捨棄這筆標記，版本紀錄不會卡住或記錯。
- 回復只改 Mac 上的檔案，不會改變中央的筆記或訂閱。下一次 `preview` 會顯示與中央目前快照的差異。

## 升級與回退

`0005_device_sync.sql` 只新增 tables、索引與 trigger，沒有 down migration，也不改 ingest。依 [CONTEXT-WORKFLOWS.md](CONTEXT-WORKFLOWS.md) 的備份與隔離 TEST 流程套用；套用前裝置不會多出任何能力，套用後也要等審閱者新增訂閱才會。若程式退回舊版，新增的 tables 保留不動，舊程式不使用它們；不要 drop tables 或刪除稽核紀錄來退版。

## 尚未完成或刻意不做

- 尚未在隔離 TEST 套用 migration、部署或做雲端合成回歸，也沒有在兩台真實 Mac 試行；這些需要各自的驗收紀錄。
- 沒有常駐程式、排程或自動套用；也不提供把檔案連結進 `AGENTS.md` 或 skills 的功能。
- 沒有速率限制；裝置讀取只有大小上限。
- 跨專案共用筆記（`include_shared`）留給後續的矛盾與修訂階段，目前的快照只包含該專案自己的筆記。
- 同步檔案不會因撤銷訂閱而刪除；計畫檔若未套用會留在 `state_dir/plans/`，可以手動清除。
- 同步工具異常結束時留下的 `sync.lock` 與同一資料夾內的 `.beacon-sync-*.tmp` 暫存檔需要手動清除。
