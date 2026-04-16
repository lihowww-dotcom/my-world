# MyWorld

一個單檔 Three.js 類 Minecraft 體素遊戲，支援多人連線：共享地形、同步玩家位置、方塊 place/break、文字聊天，資料以 SQLite 持久化。

## 專案結構

```
MyWorld/
├─ index.html             ← 登入介面 + WebSocket 客戶端
├─ package.json           ← 依賴：ws, better-sqlite3；start → node server/server.js
├─ railway.json           ← Railway 部署設定
├─ server/
│  ├─ server.js           ← HTTP + WS，每房 15Hz 位置廣播
│  ├─ db.js               ← SQLite schema + prepared statements
│  ├─ terrain.js          ← 決定性地形（seed → 固定世界）
│  └─ auth.js             ← scrypt 密碼雜湊
└─ deploy/
   ├─ myworld.service     ← systemd unit（VPS 用）
   └─ nginx.conf.example  ← wss:// 反向代理範本（VPS 用）
```

## 本機執行

```sh
npm install
npm start
```

然後開兩個瀏覽器視窗到 <http://localhost:8080>，輸入同一個房號（例如 `test`）、不同的名字／密碼，即可看見彼此。

房間與使用者首次使用會自動建立；下次登入用相同名字 + 密碼即可回到同一個世界。

環境變數：

- `PORT`（預設 `8080`）
- `HOST`（預設 `0.0.0.0`）
- `MYWORLD_DB`（預設 `./world.db`）——PaaS 上請指向 volume 內的路徑

## 部署到 Railway

1. 把這個 repo 推到 GitHub
2. [railway.com](https://railway.com) → **New Project → Deploy from GitHub repo → 選這個 repo**
3. Railway 會讀 `railway.json` 與根目錄的 `package.json`，用 Nixpacks 建置並 `npm start`
4. 在專案的 **Variables** 頁加 `MYWORLD_DB=/data/world.db`
5. 在專案的 **Volumes** 頁新增一個 volume，掛載到 `/data`（讓 SQLite 在重新部署時不會消失）
6. **Settings → Networking → Generate Domain** 產生公開網址
7. 開那個網址就能玩，朋友輸入同樣房號進來

Railway 自動支援 WebSocket upgrade，不用另外設定。

## 部署到自己的 VPS

1. 把整個 repo 放到伺服器，根目錄執行一次 `npm install`
   - `better-sqlite3` 是 native 模組，Debian/Ubuntu 需要 `build-essential python3`
2. 修改 `deploy/myworld.service` 的 `User=` 與 `WorkingDirectory=`，複製到 `/etc/systemd/system/`
3. 修改 `deploy/nginx.conf.example` 的 `server_name` 與 TLS 憑證路徑，複製到 `/etc/nginx/sites-available/`
4. 啟用服務：
   ```sh
   systemctl enable --now myworld
   systemctl reload nginx
   ```

資料庫檔預設 `world.db` 產生在執行目錄，可用 `MYWORLD_DB` 覆寫路徑；備份該檔即可。

## 🪙 搶金礦模式（房號 `digdig`）

登入時把房號填成 `digdig` 就會進到競賽房：

- 地底 y=-8 到 -1 隨機散落 **50 顆黃金方塊**
- 每輪 **3 分鐘**倒數，挖到最多黃金的人獲勝
- 所有黃金被挖完或時間到就結束本輪，公布冠軍並休息 10 秒，自動開下一輪
- 右上角即時顯示倒數、剩餘黃金數、排行榜
- 房間清空後狀態會重置，下一位玩家會開啟全新一局

其他房號仍是一般的自由建造模式。

## 架構重點

- **伺服器權威**：客戶端送請求，伺服器驗證後再廣播。方塊 place/break 不做樂觀更新，避免需要回滾。
- **Node HTTP + WS 同埠**：`index.html` 與 WebSocket 都走 `:8080`，nginx 在前面 terminate TLS。
- **決定性地形**：每個房間存一個 seed，地形從 seed 生成；僅玩家編輯過的方塊需要存 DB（v1 全存）。
- **房間記憶體快取**：首次登入時從 DB 載入方塊到記憶體，後續編輯 write-through。
- **15Hz 位置廣播**：`setInterval(66ms)` 批次打包每個房間內玩家最新位置。
- **驗證**：scrypt 雜湊、`crypto.timingSafeEqual` 比對；未驗證連線的非 login 訊息一律丟棄。
- **Rate limit**：每連線每秒最多 10 次方塊操作、每 10 秒最多 5 則聊天。

## 驗證過的功能

- 登入／房間自動建立
- 首次登入收到完整地形
- 位置 15Hz 同步（對方 avatar 平滑移動）
- 方塊 place/break 廣播給房內其他人
- 文字聊天 + 加入/離開通知
- 密碼驗證（錯誤密碼回傳 error）
- 重啟伺服器後世界與聊天記錄仍在
- 連線斷開後對方 avatar 消失

## v1 已知限制（之後再做）

- 無自動重連（斷線需要重新整理）
- 位置無插值（15Hz 直接 teleport，略有抖動）
- 整個世界存 DB（~10k 方塊／房，<100 房內不是問題）
- 無管理工具（刪房、踢人、改密碼）
- 每房無人數上限（建議之後加 `MAX_CONNS_PER_ROOM = 16`）
