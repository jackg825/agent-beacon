# Mac mini／MBP 使用方式

兩台 Mac 都保留原有 Beacon collector，繼續寫入本機 JSONL。各自啟動這個
forwarder，把新活動送到同一個獨立 Worker；中央服務使用 Cloudflare D1／R2，
不需要 Mac mini 後端、VPS 或 Cloudflare Tunnel。

已部署的獨立測試網址與驗收結果見 [TEST-DEPLOYMENT.md](TEST-DEPLOYMENT.md)。

## 新 Mac 尚未安裝 collector 時

已有 collector 的 Mac 只先確認狀態，不需要重新安裝。若 `beacon` 不在 PATH，
先確認既有安裝位置；確定尚未安裝才依上游 macOS 指南安裝 CLI：

```sh
brew trust asymptote-labs/tap
brew tap asymptote-labs/tap
brew install beacon
env BEACON_ONBOARDING=0 BEACON_MANAGED_INGEST=0 beacon endpoint install --user --dry-run
```

最後一行依本 fork 的 CLI 介面預覽本機設定／服務改動。確認範圍後才移除
`--dry-run` 執行安裝；保留兩個環境設定，且不要加 `--connect`。一般互動安裝
預選官方 Beacon Cloud，使用本框架應採用本機收集模式，再由下述 forwarder
連接自建 Worker。這些是待操作指南，本次未執行安裝或更改任何 agent 設定。

## 每台 Mac 各準備一份私有設定

準備實機試用時，先在有 Cloudflare 管理權限的機器建立兩份裝置金鑰：

```sh
cd workers/beacon-cloud
npm run device:prepare -- mbp "MBP"
npm run device:prepare -- mac-mini "Mac mini"
# 對各指令顯示的 PREPARED_DIRECTORY 分別執行；SQL 只包含 token digest：
npx wrangler d1 execute agent-beacon-cloud-test-db --remote --config .local/wrangler.test.jsonc --file PREPARED_DIRECTORY/enroll.sql
```

將各目錄的 `device-token` 私下交給對應 Mac；Mac mini 只需要自己的上傳金鑰，
不需要 Cloudflare 管理憑證。這些是實機試用前的待操作步驟，本輪只登錄了合成
測試裝置；不要把合成測試金鑰用於兩台實機。

先用 `beacon endpoint status` 確認原有 collector 正常。這份說明不會更動 collector
設定，也不使用 `beacon endpoint connect --dashboard-url ...`；那個指令需要官方
OAuth／enrollment API，不能用來連接這個 Worker。

| 設定 | MBP | Mac mini |
| --- | --- | --- |
| `endpoint` | 同一個 `https://YOUR-TEST-WORKER.workers.dev` | 與 MBP 相同 |
| 裝置 token | MBP 專用，私下取得 | Mac mini 專用，與 MBP 不同 |
| `tokenFile` | 本機私有檔案，權限 `0600` | 本機另一份私有檔案，權限 `0600` |
| `stateDir` | 本機獨立目錄，權限 `0700` | 本機獨立目錄，權限 `0700` |

在每台 Mac 將 [範例設定](forwarder/config.example.json) 複製到 **repo 外** 的私有
目錄，填入 Worker URL、展開後的絕對路徑與 `tokenFile` 路徑。token 值只放在
私有 token 檔，不能放進設定 JSON、Git、聊天、截圖或指令參數。
`stateDir` 內含待上傳內容與 checkpoints，不要用 iCloud／Dropbox 同步兩台機器的
state，也不要把它們放進公開 repo。裝置 token 僅可上傳；dashboard／MCP 使用
另外的唯讀憑證。

第一次啟動需要能連到 Worker，驗證 token 並把 state 綁定到該 Worker／裝置。
之後離線可保留新 batch，恢復連線並再次驗證後補送。同一裝置換新 token 可沿用
state；不要把其他裝置的 token 或另一個 Worker URL 填進已有的 state 設定。
若出現 `UNBOUND_EXISTING_STATE`，代表使用了早期未綁定版本的 state；保留舊
目錄供復原，改用新的私有 stateDir，依[復原說明](forwarder/README.md#durability-and-recovery)
決定是否需要歷史 backfill。

一般 user-mode log 位於：

```text
/Users/YOUR_USER/.beacon/endpoint/logs/runtime.jsonl
/Users/YOUR_USER/.beacon/endpoint/logs/inventory_state.jsonl
```

請依 `beacon endpoint status` 顯示的位置確認；不要假設 system-mode 路徑也相同。
設定中的 `~` 或環境變數不會自動展開。

## 讓兩台 Mac 的同一 repo 顯示為同一 project

若事件已有有效 Git remote，Worker 會正規化 SSH／HTTPS 與 `.git` 差異。
若事件只有本機路徑或 `file://`，在每台的 `projectMappings` 加上對應設定：

```json
{
  "path": "/Users/YOUR_USER/Workspace/YOUR_CHECKOUT",
  "remote": "https://github.com/EXAMPLE_OWNER/EXAMPLE_REPOSITORY.git"
}
```

兩台的 `path` 可以不同，`remote` 應指向同一 repo。不要在 URL 放入 credentials。
不同裝置的相同 session ID 會各自保留，並可從同一 project 跨機篩選查詢。

## 先手動啟動

需要 Node.js 22 以上。從 `workers/beacon-cloud/` 執行：

```sh
node forwarder/forwarder.mjs /ABSOLUTE/PRIVATE/PATH/config.json --once
node forwarder/forwarder.mjs /ABSOLUTE/PRIVATE/PATH/config.json
```

第一次採用範例的 runtime `readFrom: "end"` 會跳過既有 runtime 歷史，之後送出
新寫入的完整事件；此界線以首次成功驗證 Worker 為準。inventory 範例為 `"beginning"`，會送出保留的 inventory
baseline；若這不是你要的範圍，先調整再啟動。forwarder 會上傳 Beacon 已留存的
內容，包含可能存在的 prompt、tool input／output；它沒有額外的 metadata-only
轉換，啟動前應確認本機 collection／retention 設定符合預期。

輸出只有計數與固定錯誤碼。`blocked` 有值表示資料仍排在本機等待重試；
`full: true` 表示 outbox 已達容量上限。使用 Ctrl-C 正常停止，保留 state 以便接續。
若 abrupt kill 留下 `FORWARDER_LOCKED`，先確認該 forwarder 程序已停止，再依
[復原說明](forwarder/README.md#durability-and-recovery) 只移除 lock，不要刪除
checkpoint 或 outbox。

開啟 Worker 的 `/dashboard`，使用另行提供的唯讀登入方式，選擇裝置／project
檢查 session 與時間線。遠端唯讀 MCP 的連線方式見 [主文件](README.md)。

目前須手動保持 forwarder 執行；尚未提供或驗證 launchd 安裝，不會自動改動兩台
Mac 的服務或 collector 設定。正式或測試雲端驗證不代表兩台實際 collector 都已
完成安裝驗收。
