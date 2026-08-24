# Owner Video Tool

Web app để chuyển ownership video/thư mục Google Drive và bật/tắt chặn tải xuống. Bản mới dùng React/Vite frontend + Node.js API serverless để deploy lên Vercel.

## Bản Node.js/Vercel

### 1. Cài dependency

```powershell
npm install
npm --prefix web install
```

### 2. Tạo mật khẩu và file môi trường local

Anh tự đặt mật khẩu bằng lệnh này:

```powershell
npm run export:vercel-env -- --password "mat-khau-anh-tu-tao"
```

Lệnh trên sẽ tạo `.env.local` gồm:

- `OWNER_TOOL_ALLOWED_EMAIL=tamatm6713@gmail.com`
- `OWNER_TOOL_PASSWORD_HASH=...` — hash mật khẩu, không lưu plain text.
- `OWNER_TOOL_AUTH_SECRET=...`
- `OWNER_TOOL_STORE_KEY=...` — key mã hóa encrypted KV store.
- `OWNER_TOOL_ACCOUNTS_JSON_B64=...` — fallback/migration legacy; production nên dùng KV.

`.env.local` chứa secret và đã được `.gitignore`, không commit file này.

### 3. Chạy full-stack local

```powershell
npm run dev
```

Mở:

```text
http://localhost:3000
```

Đăng nhập bằng:

- Email: `tamatm6713@gmail.com`
- Password: mật khẩu anh đã đặt ở bước 2.

### Kiểm tra trước khi push

```powershell
npm ci
npm --prefix web ci
npm test
npm run typecheck
npm run build
python -m compileall -q -f .
```

Transfer và Copy Drive mặc định bắt đầu ở **Chạy thử**. Khi tắt tùy chọn này,
web sẽ yêu cầu xác nhận lần nữa trước khi ghi thay đổi vào Google Drive.

### 4. Deploy lên Vercel

Tạo project:

```powershell
npx vercel
```

Trong Vercel Dashboard, vào `Project Settings` → `Environment Variables`, copy các biến từ `.env.local` lên cả Production/Preview nếu cần:

```text
OWNER_TOOL_ALLOWED_EMAIL
OWNER_TOOL_PASSWORD_HASH
OWNER_TOOL_AUTH_SECRET
OWNER_TOOL_STORE_KEY
KV_REST_API_URL
KV_REST_API_TOKEN
KV_REST_API_READ_ONLY_TOKEN
```

Deploy production:

```powershell
npx vercel --prod
```

Nếu muốn test đúng runtime Vercel CLI:

```powershell
npm run dev:vercel
```

Nếu đang có account cũ trong `.env.local` hoặc file token local, migrate sang encrypted KV:

```powershell
npm run migrate:kv
```

## Chạy job ngầm bằng GitHub Actions (batch lớn 500+ video)

Vercel serverless giới hạn ~60s/request nên không hợp job dài. Để job chạy ngầm
server-side (bật trên web rồi out ra, tới 6h/job), tool có sẵn chế độ
**dispatch sang GitHub Actions**. Bật bằng cách thêm env, KHÔNG cần đổi code.

Chi tiết kiến trúc + giải thích: [docs/GITHUB_ACTIONS_PLAN.md](docs/GITHUB_ACTIONS_PLAN.md).

### 1. Đẩy code lên repo private

```powershell
git init
git add .
git commit -m "Owner Video Tool"
gh repo create owner-video-tool --private --source . --remote origin --push
```

`.gitignore` đã chặn mọi secret (token, credentials, .env). Không file token nào lên repo.

### 2. Lấy giá trị secret và dán lên GitHub

```powershell
npm run print:github-secrets
```

Lệnh in ra giá trị secret KV/Actions. Vào repo → **Settings → Secrets and variables →
Actions → New repository secret**:

- `KV_REST_API_URL` — URL REST của Upstash/Vercel KV.
- `KV_REST_API_READ_ONLY_TOKEN` — read-only token cho runner.
- `OWNER_TOOL_STORE_KEY` — key giải mã account bundle.
- `CREDENTIALS_JSON_B64` — tùy chọn (chỉ cần khi token B phải refresh bằng client config).

### 3. Tạo Personal Access Token (PAT)

GitHub → Settings → Developer settings → **Fine-grained tokens** → tạo token chỉ cho
repo này, quyền **Actions: Read and write**. Copy chuỗi token.

### 4. Bật chế độ dispatch trên Vercel

Thêm Environment Variables (Production + Preview):

```text
GITHUB_REPO=<github-user>/owner-video-tool
GITHUB_DISPATCH_TOKEN=<PAT vừa tạo>
# tùy chọn:
GITHUB_WORKFLOW_FILE=owner-tool.yml
GITHUB_REF=main
```

Redeploy. Từ giờ bấm chạy trên web → Vercel gửi job sang GitHub Actions → runner chạy
`auto_transfer_videos.py`/`protect_videos.py` tới khi xong. Web hiện trạng thái và link
"Xem log trực tiếp trên GitHub". Trình duyệt có thể đóng, job vẫn chạy.

> Khi đổi/refresh token A hoặc B trên web, token được ghi thẳng vào encrypted KV store;
> không cần cập nhật GitHub secret hay redeploy.

## Lưu ý quan trọng khi chạy trên Vercel

- App đã có login riêng; chỉ email `tamatm6713@gmail.com` đăng nhập được.
- API không trả token OAuth/token path ra browser.
- Token Google Drive nằm trong encrypted KV store, không nằm trong source/Gist.
- Vercel serverless phù hợp batch vừa/nhỏ. Job quá lớn có thể vượt giới hạn thời gian function; khi cần chạy batch rất dài, dùng bản local Python cũ hoặc chuyển backend sang server dài hạn/queue.
- Tab `Tài khoản` trên bản Vercel mở OAuth Google và ghi account vào encrypted KV store.

## File chính

| File/thư mục | Vai trò |
| --- | --- |
| `api/index.js` | Node.js API serverless cho Vercel: auth, accounts, transfer, block. |
| `web/` | React/Vite frontend responsive desktop/mobile. |
| `scripts/export-vercel-env.mjs` | Tạo `.env.local` từ registry token local và mật khẩu anh tự đặt. |
| `vercel.json` | Cấu hình build/deploy Vercel. |
| `web_server.py` | FastAPI backend local cũ, giữ lại để dùng khi cần chạy desktop/local lâu. |
| `auto_transfer_videos.py` | CLI transfer owner hàng loạt từ folder. |
| `protect_videos.py` | CLI block/unblock tải xuống, copy, print video Drive. |

## Bản Python local cũ

Nếu cần chạy job dài trên máy local:

```powershell
pip install -r requirements.txt
python web_server.py
```

Hoặc double-click:

```powershell
run_web_app.bat
```
