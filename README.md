---
title: xlsx2webform
emoji: 📊
colorFrom: blue
colorTo: green
sdk: docker
pinned: false
---

# xlsx2webform — 預算表單編輯器

上傳 Excel → 轉為可編輯網頁表格 → 發布為填寫表單 → 收集回應

---

## 專案目的

讓不熟悉 Excel 或不使用桌機的使用者，能透過瀏覽器完成：

- **編輯端**：上傳 XLSX 預算表，在網頁上修改欄位、套用公式、管理層級
- **發布端**：產生分享連結，開放給填表人
- **填表端**：在手機/電腦上填寫並送出
- **管理端**：檢視所有回應、匯出 CSV

適合公部門預算表、問卷調查、經費申請單等需要多人填寫的表格場景。

---

## 🌟 進階特色功能

為了滿足實際數據收集情境與提升企業級安全性，本專案全新引入了以下重大功能：

### 1. 🔑 專案發起人身分驗證與密碼保護
- **專案防護**：上傳 Excel 新建專案時，發起人可設定 Email 與編輯密碼。
- **全 API 保護**：所有涉及專案數據編輯、導出、發布、刪除、及查看 responses 列表的 API，皆在後端通過 **SHA256 密碼雜湊驗證** 嚴密鎖定。
- **無縫解鎖遮罩**：前端加入「不透明密碼輸入 Overlay」遮罩阻絕任何數據泄露，並將憑證緩存在 `sessionStorage` 提供一鍵免登入重載。
- **刪除確認**：防禦他人惡意刪除專案，唯有填入正確密碼方能執行刪除。

### 2. 📝 填表人身分綁定與「自動辨識覆蓋修正」
- **資料修正無重複**：填表人可在送出時填寫其 Email 與填表密碼。
- **自動覆蓋**：日後若發現填寫有誤，使用**相同 Email 和密碼**再次送出時，後端會自動辨識並**覆蓋更新**其先前同一筆數據（維持原 response_id 且不產生重複垃圾行），完美保持統計乾淨！
- **歷史數據反填**：填表人點擊「🔍 載入我之前填過的資料」，輸入 Email/密碼校驗通過後，可將之前填寫的全部數據一鍵帶回畫面，直接微調後重新送出。
- **發起人修正提醒**：當填寫人修正其數據後，管理員的「回應結果」列表中會立刻在該員名字旁貼上 **`⚠️ 已修正`** 黃色顯眼標章（hover 可見修改時間），提供發起者最醒目的通知。

### 3. 📥 填表端 Excel 匯入與「欄位比對驗證防呆」
- **極速填寫**：支援填表人直接拖放或上傳其 `.xlsx` 檔案，一鍵將整份 Excel 填寫內容匯入到網頁表格中，省去逐字敲打的煩惱。
- **嚴格格式比對**：後端提供 Stateless 專屬 Excel 解析 API；前端接收數據後，會與目前發布的表單進行**雙重驗證（欄位數量是否一致、欄位名稱順序是否相同）**，若有一絲不符，立即彈出詳細錯誤提示並**拒絕匯入**，保障收集數據的絕對一致性。

### 4. 📊 彙整表與 CSV 匯出的跨列 `rowspan` 聚合分組
- **高質感對齊**：如果上傳的 Excel 檔案包含多行（例如 280 列的 checklist），回應列表在呈現時會使用 **`rowspan` 跨列聚合技術** 將填表人身分（姓名、Email、修改標章、時間）以及「刪除回應」按鈕完美分組合併，整個大畫面乾淨精巧。
- **關係型 CSV 導出**：CSV 導出時會自動拆分，呈現完美的關係型資料表，極度方便發佈者在 Excel 裡面做樞紐分析（Pivot Table）或統計！

---

## 使用者流程

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│ 上傳 XLSX │ → │ 編輯表格 │ → │ 發布表單 │ → │ 填表人填寫 │
│          │    │ 儲存/重置 │    │ 取得連結 │    │ 提交回應   │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
                                                      │
                                                      ▼
                                              ┌──────────┐
                                              │ 編輯端查看 │
                                              │ 回應/匯出 │
                                              └──────────┘
```

### 三種頁面模式

| 頁面 | 路由 | 用途 |
|------|------|------|
| 專案列表 | `/` | 顯示所有專案、上傳新檔案、刪除專案 |
| 編輯器 | `/editor/{id}` | 編輯表格內容、公式、發布表單、檢視回應 |
| 填寫頁 | `/fill/{token}` | 填表人填寫資料並提交 |

---

## 架構概覽

```
┌─────────────────────────────────────────────────────┐
│                   瀏覽器 (index.html)                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │ projects │  │  editor  │  │   fill   │          │
│  │ -section │  │  (編輯)   │  │  (填寫)   │          │
│  └──────────┘  └──────────┘  └──────────┘          │
│         CSS 注入控制顯示 (伺服器端 per-route)        │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP / JSON API
┌──────────────────────┴──────────────────────────────┐
│              FastAPI 後端 (main.py)                   │
│                                                      │
│  sessions ──→ data/session_{id}.json (個別存檔)      │
│  publish_store ──→ data/publish_store.json            │
│  response_store ──→ data/response_store.json          │
│                                                      │
│  openpyxl ← XLSX 解析 (xlsx_parser.py)               │
└─────────────────────────────────────────────────────┘
```

關鍵設計決策：

- **CSS 注入 per-route**：伺服器在 `</head>` 前插入 `<style>` + `<script>`，決定哪個區塊顯示，不依賴 JS 執行時機
- **檔案持久化**：所有 session、發布狀態、回應寫入 `data/` 目錄 JSON 檔，可承受 Railway/HF Spaces 重啟
- **單頁三模式**：前端 `index.html` 含三個區塊（projects-section / editor / fill-mode），同一份 HTML 三種呈現

---

## 檔案說明

### `backend/main.py` — FastAPI 主程式 (636 行)

#### 資料模型

| 類別 | 用途 |
|------|------|
| `SessionData` | 單一專案的完整資料（id, name, json data, metadata, timestamps） |
| `SaveRequest` | 儲存請求（session_id + data） |
| `TemplateData` | 範本儲存請求 |
| `PublishResponse` | 發布回應（share_token, fill_url, response_count） |
| `SubmitRequest` | 填表提交（data + 選填 respondent） |

#### 儲存層（Persistence）

```
sessions (dict)          → data/session_{id}.json  (個別)
publish_store (dict)     → data/publish_store.json
published_forms (dict)   → data/published_forms.json
response_store (dict)    → data/response_store.json
sessions_index (list)    → data/sessions_index.json
```

- `_load_persist()` — 啟動時從檔案還原所有 store
- `_save_persist(key)` — 寫回 publish_store / published_forms / response_store
- `_save_session(sid)` — 寫回單一 session JSON + 更新 index

#### 路由一覽

| 方法 | 路徑 | 用途 | 安全限制 |
|------|------|------|----------|
| GET | `/` | 首頁（專案列表）、伺服端 CSS 注入 | 公開 |
| GET | `/editor/{id}` | 編輯器頁面、CSS 注入 | 密碼鎖定 |
| GET | `/fill/{token}` | 填寫頁面、CSS 注入 | 公開 |
| POST | `/api/upload-xlsx` | 上傳 XLSX 建立新專案 | 設定發起人 Email & 密碼 |
| POST | `/api/parse-xlsx` | 填寫端 Excel 免存檔解析 API | 公開（嚴格欄位校驗） |
| GET | `/api/sessions` | 列出所有 session 簡介 | 公開 |
| GET | `/api/sessions/{id}` | 取得單一 session 資料 | 需 `X-Project-Password` |
| POST | `/api/sessions/{id}/save` | 儲存編輯後的 data | 需 `X-Project-Password` |
| GET | `/api/sessions/{id}/export/json` | 匯出 JSON | 需 `X-Project-Password` |
| POST | `/api/sessions/{id}/import/json` | 匯入 JSON | 需 `X-Project-Password` |
| POST | `/api/sessions/{id}/reset` | 重置為原始資料 | 需 `X-Project-Password` |
| DELETE | `/api/sessions/{id}` | 刪除 session | 需 `X-Project-Password` |
| POST | `/api/sessions/{id}/publish` | 發布（產生存取 token） | 需 `X-Project-Password` |
| GET | `/api/sessions/{id}/publish` | 查詢發布狀態 | 需 `X-Project-Password` |
| DELETE | `/api/sessions/{id}/publish` | 取消發布 | Ref / getAuthHeaders() |
| GET | `/api/fill/{token}/data` | 填表端取得表單資料 | 公開 |
| POST | `/api/fill/{token}/submit` | 填表端提交或覆蓋修正回應 | 驗證填表者 Email & 密碼 |
| POST | `/api/fill/{token}/load-response` | 填表端載入歷史填表資料 | 驗證填表者 Email & 密碼 |
| GET | `/api/sessions/{id}/responses` | 列出所有回應 | 需 `X-Project-Password` |
| GET | `/api/sessions/{id}/responses/{rid}` | 取得單一回應 | 需 `X-Project-Password` |
| DELETE | `/api/sessions/{id}/responses/{rid}` | 刪除回應 | 需 `X-Project-Password` |
| GET | `/api/sessions/{id}/responses/export/csv` | 匯出 CSV | 需 `X-Project-Password` / Query 密碼 |

#### 發布流程

```
POST /api/sessions/{id}/publish
  → 產生 uuid token（或沿用已存在的）
  → publish_store[token] = session_id
  → published_forms[session_id] = token
  → 回傳 share_token + fill_url
```

#### CSS 注入（三種路由的差異）

```python
# 首頁：隱藏 editor、fill-mode、fill-banner
head_style = '<style>#editor{display:none!important}#fill-mode{display:none!important}#fill-banner{display:none!important}</style>'

# 編輯器：隱藏 projects、fill-mode、fill-banner，顯示 editor
head_style = '<style>#projects-section{display:none!important}#fill-mode{display:none!important}#fill-banner{display:none!important}#editor{display:block!important}</style>'

# 填寫頁：隱藏 projects、editor，顯示 fill-mode、fill-banner
head_style = '<style>#projects-section{display:none!important}#editor{display:none!important}#fill-mode{display:block!important}#fill-banner{display:block!important}</style>'
```

#### 快取控制

所有 HTML 回應附加：

```python
headers={
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0"
}
```

---

### `backend/xlsx_parser.py` — XLSX 解析器 (495 行)

#### 架構

```
process_xlsx(file_path, sheet_index, mode)
  ├── mode='table': worksheet_to_html() + worksheet_to_json()
  └── mode='form':  extract_form_data()
```

#### 核心函式

| 函式 | 用途 |
|------|------|
| `process_xlsx()` | 入口：載入 openpyxl，依 mode 分流 |
| `worksheet_to_html()` | 產生 HTML `<table>`，含合併儲存格 (rowspan/colspan) |
| `worksheet_to_json()` | 產生 JSON 結構（row, col, value, type, style） |
| `extract_form_data()` | 解析表單結構（label/value/section） |
| `build_merged_cells_map()` | 建立合併儲存格索引，避開非左上角 cell |
| `get_fill_color()` | 讀取儲存格背景色 |
| `get_marker_class()` | 根據字體顏色回傳 CSS class（marker-orange, marker-blue 等） |

#### 技術細節

- 使用 `openpyxl` 的 `data_only=True` 讀取計算後的值
- 合併儲存格：先掃 `ws.merged_cells.ranges` 建立 dict 索引，渲染時跳過非左上角 cell
- 顏色標記：比對 hex color 回傳語意 class（如 `marker-blue`、`marker-red`）

---

### `frontend/index.html` — 前端 (775 行)

#### CSS 樣式主題

| 區塊 | 主要 class |
|------|------------|
| 專案卡片 | `.project-card`, `.project-grid` |
| 編輯器工具列 | `.toolbar`, `.btn` 系列 |
| 表格 | `.table-wrap`, `.scroll`, `table` |
| 層級縮排 | `.lv-1`, `.lv-2`, `.lv-3`, `.lv-4` |
| 公式標記 | `.formula`, `.auto-sum`, `.formula-cell` |
| 填寫模式 | `.fill-banner`, `.submit-bar`, `.submit-msg` |
| 發布對話框 | `.modal-overlay`, `.modal-box` |
| 回應儀表板 | `.resp-compare-table`, `.resp-item` |
| 上傳區 | `.drop-zone`, `.upload-area` |

#### HTML 結構

```html
<body>
  <header> ... </header>
  <div id="fill-banner"> 填寫模式提示 </div>
  <main>
    <div id="projects-section"> 專案列表 </div>
    <div id="editor"> 編輯器 (含 editor-tab + responses-tab) </div>
    <div id="fill-mode"> 填寫表單 </div>
  </main>
  <div id="toast"> 提示訊息 </div>
  <div id="publish-dialog"> 發布對話框 </div>
</body>
```

#### JavaScript 三大模式

模式偵測：

```javascript
const isFillMode = !!(window.FILL_TOKEN);
const isEditorMode = !!(window.EDIT_SESSION_ID);
const isLanding = window.LANDING_MODE === 'projects';
```

##### 1. 專案模式 (`initProjectsPage()`)

| 功能 | 說明 |
|------|------|
| `loadProjects()` | GET `/api/sessions` → 渲染專案卡片 |
| `deleteProject(id)` | DELETE `/api/sessions/{id}` → 重新載入 |
| `projectUpload(file)` | POST `/api/upload-xlsx` → 導向 `/editor/{id}` |
| 拖放上傳 | drag/drop + click 觸發 input file |

##### 2. 編輯器模式 (`initEditorWithSession()`)

| 功能 | 說明 |
|------|------|
| `render()` | data → HTML table（含層級 class、公式標記、數值格式化） |
| `recalcAutoSum()` | 計算父子層級 auto-sum 值 |
| `applyFormula()` | 依公式字串逐列計算（`=A+B` 等） |
| `onChange` | 編輯事件 → 更新 data array |
| `onKeyDown` | Tab/Enter/Escape 導航 |
| `onPaste` | 貼上 Excel tab-separated 資料 |
| `loadResponses()` | 載入回應比較表 |
| 分頁切換 | edit / responses tab |

編輯器資料結構：

```javascript
data = [
  [  // row 0: headers
    {row:1, col:1, value:"項目", type:"str"},
    {row:1, col:2, value:"金額", type:"str"}
  ],
  [  // row 1: data
    {row:2, col:1, value:"收入", type:"str"},
    {row:2, col:2, value:"100000", type:"str", _autoSum:true}
  ]
]
```

發佈功能：

```javascript
// 按「發布表單」→ 開啟 dialog → GET 查詢狀態
// 按「產生連結」→ POST /api/sessions/{id}/publish → 顯示分享連結
// 按「取消發布」→ DELETE /api/sessions/{id}/publish
```

##### 3. 填寫模式 (`initFillMode()`)

| 功能 | 說明 |
|------|------|
| `renderFillTable()` | 產生填寫表格（auto-sum 欄位 disabled） |
| `onFillChange()` | 更新本地 data |
| `onFillPaste()` | 貼上 Excel 資料 |
| btn-fill-submit | POST `/api/fill/{token}/submit` → 顯示 success 訊息 |
| btn-fill-reset | 重置為原始資料 |
| btn-fill-add-row | 新增空白列 |
| btn-fill-another | 提交後再填一筆 |

填寫資料提交：

```javascript
fetch(`/api/fill/${fillToken}/submit`, {
  method: 'POST',
  body: JSON.stringify({data, respondent})
})
```

---

### `Dockerfile`

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 7860
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "7860"]
```

### `requirements.txt`

```
fastapi==0.115.0
uvicorn[standard]==0.30.0
python-multipart==0.0.9
openpyxl==3.1.5
pydantic==2.9.0
aiofiles==24.1.0
```

---

## 部署

### Railway (GitHub 連動)

1. 將 `budget_app/` 內容 push 到 GitHub repo
2. Railway 連動該 repo
3. 設定 Start Command: `uvicorn backend.main:app --host 0.0.0.0 --port $PORT`
4. Railway 會自動偵測 Dockerfile 或 Python 直啟

### 本機開發

```bash
cd budget_app
pip install -r requirements.txt
uvicorn backend.main:app --host 0.0.0.0 --port 7860 --reload
```

或雙擊 `啟動預算編輯器.command`（macOS 自動建立 venv + 啟動）。

### Hugging Face Spaces

`sdk: docker`（已寫在 README frontmatter），HF Spaces 會自動 build Dockerfile。

---

## ⚙️ 部署注意事項

- **必須以單一 uvicorn worker 執行**：本服務的工作階段、發布狀態與回應資料儲存在「記憶體 dict + data/ 下的 JSON 檔」，並非跨行程共享。請勿使用 `--workers` 大於 1，否則各 worker 狀態不一致會導致資料錯亂。Docker 預設 CMD 即為單一 worker。
- **資料持久化**：所有狀態寫入 data/ 目錄，請確保該目錄在容器/主機重啟後仍存在（掛載 volume）。
- **啟動清理**：服務啟動時會自動移除 uploads/ 中的暫存檔（temp_ 開頭）與不再對應任何工作階段的孤立檔案。

## 🔒 安全性說明（近期強化）

- 分享連結 token 改用約 128-bit 的不可預測亂數，抵抗列舉攻擊。
- 填表資料讀取端點加入速率限制，降低被掃描枚舉的風險。
- 所有 API 的錯誤回應不再外洩內部例外細節，詳細錯誤僅寫入伺服器日誌。
- 匯出 JSON 改為記憶體串流回傳，不再於伺服器留下暫存檔。
