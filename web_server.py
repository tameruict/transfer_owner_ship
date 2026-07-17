"""Local FastAPI server for the Owner Video Tool web interface."""

from __future__ import annotations

import os
import base64
import hashlib
import hmac
import json
import subprocess
import sys
import threading
import time
import uuid
import webbrowser
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal
from urllib.parse import parse_qs
from wsgiref.simple_server import WSGIRequestHandler, make_server

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from pydantic import BaseModel, Field, field_validator

from account_store import Account, find_account, load_registry, save_registry, save_token_json, upsert
from auto_transfer_videos import extract_folder_id
from drive_common import FOLDER_MIME_TYPE
from transfer_ownership import SCOPES, build_drive_service, get_file, load_credentials

# The OAuth callback runs on a loopback http://localhost address, which oauthlib
# rejects ("OAuth 2 MUST utilize https") unless this flag is set. Loopback http is
# the standard, safe redirect for installed-app OAuth, so allow it explicitly.
os.environ.setdefault("OAUTHLIB_INSECURE_TRANSPORT", "1")

ROOT = Path(__file__).resolve().parent
WEB_DIST = ROOT / "web" / "dist"
CREDENTIALS = ROOT / "credentials.json"
A_REGISTRY, A_TOKEN_DIR = ROOT / "account_a_accounts.json", ROOT / "account_a_tokens"
B_REGISTRY, B_TOKEN_DIR = ROOT / "account_b_accounts.json", ROOT / "account_b_tokens"
LEGACY_A_TOKEN = ROOT / "token.json"
TRANSFER_SCRIPT, PROTECT_SCRIPT = ROOT / "auto_transfer_videos.py", ROOT / "protect_videos.py"
COPY_DRIVE_SCRIPT = ROOT / "copy_drive.py"
SESSION_COOKIE = "owner_tool_session"
SESSION_TTL_SECONDS = 60 * 60 * 12


def load_env_local() -> None:
    file = ROOT / ".env.local"
    if not file.is_file():
        return
    for line in file.read_text(encoding="utf-8").splitlines():
        trimmed = line.strip()
        if not trimmed or trimmed.startswith("#") or "=" not in trimmed:
            continue
        key, value = trimmed.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


load_env_local()
ALLOWED_EMAIL = os.getenv("OWNER_TOOL_ALLOWED_EMAIL", "tamatm6713@gmail.com").strip().lower()


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def base64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def decode_base64url(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def auth_secret() -> str:
    secret = os.getenv("OWNER_TOOL_AUTH_SECRET")
    if not secret:
        raise HTTPException(500, "OWNER_TOOL_AUTH_SECRET is missing. Run npm run export:vercel-env first.")
    return secret


def sign_session(value: str) -> str:
    digest = hmac.new(auth_secret().encode("utf-8"), value.encode("utf-8"), hashlib.sha256).digest()
    return base64url(digest)


def create_session(email: str) -> str:
    payload = base64url(json.dumps({
        "email": email,
        "exp": int(time.time()) + SESSION_TTL_SECONDS,
    }, separators=(",", ":")).encode("utf-8"))
    return f"{payload}.{sign_session(payload)}"


def verify_session(request: Request) -> dict | None:
    token = request.cookies.get(SESSION_COOKIE, "")
    if "." not in token:
        return None
    try:
        payload, signature = token.split(".", 1)
        if not hmac.compare_digest(signature, sign_session(payload)):
            return None
        data = json.loads(decode_base64url(payload).decode("utf-8"))
        if int(data.get("exp", 0)) < int(time.time()):
            return None
        email = str(data.get("email", "")).strip().lower()
        if email != ALLOWED_EMAIL:
            return None
        return {"email": email}
    except Exception:
        return None


# Best-effort in-memory login throttle: after LOGIN_MAX_ATTEMPTS failures from
# one IP inside the window, further attempts are rejected with 429 until the
# window rolls over. A successful login clears the counter so a legitimate user
# is never locked out by their own earlier typos.
LOGIN_MAX_ATTEMPTS = 5
LOGIN_WINDOW_SECONDS = 15 * 60
login_attempts: dict[str, dict] = {}
login_attempts_lock = threading.Lock()


def client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def login_retry_after(ip: str) -> int:
    now = time.time()
    with login_attempts_lock:
        entry = login_attempts.get(ip)
        if not entry:
            return 0
        if now - entry["first"] > LOGIN_WINDOW_SECONDS:
            login_attempts.pop(ip, None)
            return 0
        if entry["count"] >= LOGIN_MAX_ATTEMPTS:
            return int(LOGIN_WINDOW_SECONDS - (now - entry["first"])) + 1
        return 0


def record_login_failure(ip: str) -> None:
    now = time.time()
    with login_attempts_lock:
        entry = login_attempts.get(ip)
        if not entry or now - entry["first"] > LOGIN_WINDOW_SECONDS:
            login_attempts[ip] = {"count": 1, "first": now}
        else:
            entry["count"] += 1


def clear_login_attempts(ip: str) -> None:
    with login_attempts_lock:
        login_attempts.pop(ip, None)


def verify_password(password: str) -> bool:
    plain = os.getenv("OWNER_TOOL_PASSWORD")
    if plain:
        return hmac.compare_digest(password, plain)

    hash_value = os.getenv("OWNER_TOOL_PASSWORD_HASH")
    if hash_value:
        try:
            algorithm, salt, key = hash_value.split(":", 2)
        except ValueError:
            return False
        if algorithm != "scrypt" or not salt or not key:
            return False
        derived = hashlib.scrypt(
            password.encode("utf-8"),
            salt=salt.encode("utf-8"),
            n=16384,
            r=8,
            p=1,
            dklen=len(key) // 2,
        ).hex()
        return hmac.compare_digest(derived, key)

    raise HTTPException(500, "OWNER_TOOL_PASSWORD or OWNER_TOOL_PASSWORD_HASH is missing. Run npm run export:vercel-env first.")


class OAuthRequest(BaseModel):
    role: Literal["A", "B"]


class LoginRequest(BaseModel):
    password: str = ""
    email: str | None = None


class TransferRow(BaseModel):
    folders: list[str] = Field(min_length=1)
    receiver_email: str

    @field_validator("folders")
    @classmethod
    def nonblank_folders(cls, value: list[str]) -> list[str]:
        if any(not item.strip() for item in value):
            raise ValueError("Folder URL/ID cannot be blank")
        return value


class TransferRequest(BaseModel):
    owner_email: str
    rows: list[TransferRow] = Field(min_length=1)
    mode: Literal["consumer", "workspace"] = "consumer"
    scope: Literal["videos", "files", "folders", "all"] = "videos"
    recursive: bool = True
    no_notify: bool = False
    dry_run: bool = False
    workers: int = Field(default=4, ge=1, le=16)
    verify: bool = False


class BlockRequest(BaseModel):
    owner_email: str
    folders: list[str] = Field(min_length=1)
    recursive: bool = True
    unblock: bool = False
    target: Literal["videos", "files", "sheets"] | None = None
    dry_run: bool = False
    workers: int = Field(default=4, ge=1, le=16)


class CopyDriveRequest(BaseModel):
    owner_email: str
    dest: str
    sources: list[str] = Field(min_length=1)
    recursive: bool = True
    checkpoint: bool = True
    dry_run: bool = False
    workers: int = Field(default=10, ge=1, le=16)
    exclude: str = ""
    sort: Literal["name", "stt"] = "name"
    filter_mode: Literal["all", "files", "videos", "custom"] = "all"
    file_extensions: list[str] = Field(default_factory=list)
    video_extensions: list[str] = Field(default_factory=list)


def inspect_token(path: Path) -> Account:
    creds = load_credentials(str(path))
    service = build("drive", "v3", credentials=creds, cache_discovery=False)
    user = service.about().get(fields="user(displayName,emailAddress)").execute().get("user", {})
    email = str(user.get("emailAddress", "")).strip()
    if not email:
        raise RuntimeError("Google Drive did not return the account email")
    return Account(email, str(path.resolve()), str(user.get("displayName", "")).strip())


class AccountManager:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.a, self.active_a = load_registry(A_REGISTRY)
        self.b, _ = load_registry(B_REGISTRY)
        self.migration_attempted = False

    def migrate(self) -> None:
        with self.lock:
            if self.migration_attempted or self.a or not LEGACY_A_TOKEN.is_file():
                return
            self.migration_attempted = True
        try:
            account = inspect_token(LEGACY_A_TOKEN)
        except Exception:
            return
        with self.lock:
            self.a = upsert(self.a, account)
            self.active_a = account.email
            save_registry(A_REGISTRY, self.a, self.active_a)

    def list(self, role: str) -> list[Account]:
        self.migrate()
        with self.lock:
            return list(self.a if role == "A" else self.b)

    def get(self, role: str, email: str) -> Account | None:
        return find_account(self.list(role), email)

    def add(self, role: str, account: Account) -> None:
        with self.lock:
            if role == "A":
                self.a, self.active_a = upsert(self.a, account), account.email
                save_registry(A_REGISTRY, self.a, self.active_a)
            else:
                self.b = upsert(self.b, account)
                save_registry(B_REGISTRY, self.b, account.email)

    def activate(self, email: str) -> Account:
        with self.lock:
            account = find_account(self.a, email)
            if account is None:
                raise KeyError(email)
            if not Path(account.token_path).is_file():
                raise FileNotFoundError(account.token_path)
            self.active_a = account.email
            save_registry(A_REGISTRY, self.a, self.active_a)
            return account

    def remove(self, role: str, email: str) -> Account:
        with self.lock:
            items = self.a if role == "A" else self.b
            account = find_account(items, email)
            if account is None:
                raise KeyError(email)
            remaining = [x for x in items if x.email.casefold() != account.email.casefold()]
            if role == "A":
                self.a = remaining
                if self.active_a.casefold() == account.email.casefold():
                    self.active_a = self.a[0].email if self.a else ""
                save_registry(A_REGISTRY, self.a, self.active_a)
            else:
                self.b = remaining
                save_registry(B_REGISTRY, self.b, "")
        # Best-effort delete of the managed token file (outside the lock).
        try:
            token = Path(account.token_path)
            if token.is_file():
                token.unlink()
        except OSError:
            pass
        return account


accounts = AccountManager()
oauth_runs: dict[str, dict] = {}
oauth_sessions: dict[str, dict] = {}
oauth_lock = threading.RLock()
# Maximum time to wait for the user to finish the Google login before the
# session auto-fails, so a closed/abandoned tab never wedges the next attempt.
OAUTH_WAIT_SECONDS = int(os.getenv("OWNER_TOOL_OAUTH_TIMEOUT", "300"))


def public_account(item: Account, active: bool = False) -> dict:
    return {"email": item.email, "display_name": item.display_name, "active": active}


class QuietOAuthRequestHandler(WSGIRequestHandler):
    def log_message(self, format: str, *args) -> None:
        return


def create_oauth_session() -> tuple[InstalledAppFlow, object, dict[str, str], str]:
    flow = InstalledAppFlow.from_client_secrets_file(str(CREDENTIALS), scopes=SCOPES)
    callback: dict[str, str] = {}

    def callback_app(environ, start_response):
        query = environ.get("QUERY_STRING", "")
        params = parse_qs(query)
        callback["authorization_response"] = flow.redirect_uri + (f"?{query}" if query else "")
        callback["error"] = params.get("error", [""])[0]
        message = "Dang nhap thanh cong. Ban co the dong tab nay."
        if callback["error"]:
            message = "Google khong hoan tat dang nhap. Ban co the dong tab nay va thu lai."
        body = f'<!doctype html><meta charset="utf-8"><title>Owner Tool OAuth</title><p>{message}</p>'
        start_response("200 OK", [("Content-Type", "text/html; charset=utf-8")])
        return [body.encode("utf-8")]

    server = make_server("localhost", 0, callback_app, handler_class=QuietOAuthRequestHandler)
    flow.redirect_uri = f"http://localhost:{server.server_port}/"
    authorization_url, _ = flow.authorization_url(access_type="offline", prompt="select_account consent")
    return flow, server, callback, authorization_url


def finish_oauth_session(oauth_id: str, session: dict) -> None:
    role = session["role"]
    flow = session["flow"]
    server = session["server"]
    callback = session["callback"]
    try:
        # Poll in short slices instead of blocking forever, so we can react to a
        # cancellation (user clicked add-account again) or an overall timeout.
        server.timeout = 1
        deadline = time.time() + OAUTH_WAIT_SECONDS
        while not callback:
            if session.get("cancelled"):
                raise RuntimeError("Da huy phien dang nhap Google truoc do")
            if time.time() > deadline:
                raise RuntimeError("Het thoi gian cho dang nhap Google. Hay thu lai.")
            server.handle_request()
        if callback.get("error"):
            raise RuntimeError(f"Google login failed: {callback['error']}")
        authorization_response = callback.get("authorization_response")
        if not authorization_response:
            raise RuntimeError("Google login did not return an authorization code")
        flow.fetch_token(authorization_response=authorization_response)
        creds = flow.credentials
        if not creds.refresh_token:
            raise RuntimeError("Google did not return a refresh token; revoke access and try again")
        service = build("drive", "v3", credentials=creds, cache_discovery=False)
        user = service.about().get(fields="user(displayName,emailAddress)").execute().get("user", {})
        email = str(user.get("emailAddress", "")).strip()
        if not email:
            raise RuntimeError("Google Drive did not return the account email")
        token = save_token_json(A_TOKEN_DIR if role == "A" else B_TOKEN_DIR, role, email, creds.to_json())
        accounts.add(role, Account(email, str(token), str(user.get("displayName", "")).strip()))
        with oauth_lock:
            oauth_runs[oauth_id].update(status="completed", message="Account saved", email=email, finished_at=now())
    except Exception as exc:
        with oauth_lock:
            oauth_runs[oauth_id].update(status="failed", message=str(exc), error=str(exc), finished_at=now())
    finally:
        server.server_close()
        with oauth_lock:
            oauth_sessions.pop(oauth_id, None)


def oauth_worker(oauth_id: str, role: str) -> None:
    with oauth_lock:
        session = oauth_sessions.get(oauth_id)
    if session:
        finish_oauth_session(oauth_id, session)
        return
    with oauth_lock:
        oauth_runs[oauth_id].update(status="failed", message="OAuth session is missing",
            error="OAuth session is missing", finished_at=now())
    return


class Job:
    def __init__(self, kind: str, commands: list[list[str]]) -> None:
        self.id, self.kind, self.commands = uuid.uuid4().hex, kind, commands
        self.status, self.created_at = "queued", now()
        self.started_at = self.finished_at = None
        self.return_code: int | None = None
        self.logs: list[str] = []
        self.process: subprocess.Popen[str] | None = None
        self.stop_requested = False
        self.lock = threading.RLock()
        sensitive_flags = {"--owner-token", "--accept-token", "--token", "--credentials"}
        self.sensitive_values = {
            command[index + 1]
            for command in commands
            for index, value in enumerate(command[:-1])
            if value in sensitive_flags
        }

    def log(self, line: str) -> None:
        with self.lock:
            for sensitive in self.sensitive_values:
                line = line.replace(sensitive, "[local token]")
            self.logs.append(line.rstrip("\r\n"))
            self.logs[:] = self.logs[-4000:]

    def public(self, after: int = 0) -> dict:
        with self.lock:
            after = max(0, min(after, len(self.logs)))
            return {"id": self.id, "type": self.kind, "status": self.status,
                "created_at": self.created_at, "started_at": self.started_at,
                "finished_at": self.finished_at, "return_code": self.return_code,
                "logs": self.logs[after:], "next_log_offset": len(self.logs)}

    def run(self) -> None:
        self.status, self.started_at = "running", now()
        code = 0
        try:
            for index, command in enumerate(self.commands, 1):
                if self.stop_requested:
                    break
                if len(self.commands) > 1:
                    self.log(f"[job] Starting batch {index}/{len(self.commands)}")
                env = os.environ.copy()
                env["PYTHONUNBUFFERED"] = "1"
                flags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
                self.process = subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
                    bufsize=1, env=env, creationflags=flags)
                assert self.process.stdout
                for line in self.process.stdout:
                    self.log(line)
                code = self.process.wait()
                self.process = None
                if code:
                    break
        except Exception as exc:
            self.log(f"[job error] {exc}")
            code = 1
        self.return_code, self.finished_at = code, now()
        self.status = "stopped" if self.stop_requested else ("completed" if code == 0 else "failed")

    def stop(self) -> None:
        with self.lock:
            if self.status not in {"queued", "running"}:
                return
            self.stop_requested, process = True, self.process
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()


jobs: dict[str, Job] = {}
jobs_lock = threading.RLock()


def validate_owner(email: str) -> Account:
    account = accounts.get("A", email)
    if account is None:
        raise HTTPException(400, "Account A is not registered")
    if accounts.active_a.casefold() != account.email.casefold():
        raise HTTPException(409, "Select this account A as active before starting the job")
    if not Path(account.token_path).is_file():
        raise HTTPException(400, "The selected account A token is missing")
    return account


def validate_folders(owner: Account, values: list[str]) -> list[str]:
    try:
        folder_ids = list(dict.fromkeys(extract_folder_id(value) for value in values))
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    try:
        service = build_drive_service(owner.token_path)
        for folder_id in folder_ids:
            if get_file(service, folder_id).mime_type != FOLDER_MIME_TYPE:
                raise HTTPException(422, f"Drive item is not a folder: {folder_id}")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(400, "Cannot access one of the selected folders with account A") from exc
    return folder_ids


def start_job(kind: str, commands: list[list[str]]) -> Job:
    with jobs_lock:
        if any(item.status in {"queued", "running"} for item in jobs.values()):
            raise HTTPException(409, "Another Drive job is already running")
        job = Job(kind, commands)
        jobs[job.id] = job
    threading.Thread(target=job.run, daemon=True).start()
    return job


app = FastAPI(title="Owner Video Tool", version="1.0.0")

PUBLIC_API_PATHS = {"/api/health", "/api/auth/session", "/api/auth/login"}


@app.middleware("http")
async def require_api_session(request: Request, call_next):
    path = request.url.path.rstrip("/") or "/"
    if path.startswith("/api/") and path not in PUBLIC_API_PATHS and not verify_session(request):
        return JSONResponse(status_code=401, content={"detail": "Vui lòng đăng nhập lại"})
    return await call_next(request)


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "service": "owner-video-tool"}


@app.get("/api/auth/session")
def auth_session(request: Request) -> dict:
    user = verify_session(request)
    return {"authenticated": bool(user), "user": user}


@app.post("/api/auth/login")
def auth_login(request: LoginRequest, response: Response, http_request: Request) -> dict:
    ip = client_ip(http_request)
    retry_after = login_retry_after(ip)
    if retry_after:
        minutes = -(-retry_after // 60)
        raise HTTPException(
            429,
            f"Quá nhiều lần đăng nhập sai. Thử lại sau {minutes} phút.",
            headers={"Retry-After": str(retry_after)},
        )
    email = (request.email or ALLOWED_EMAIL).strip().lower()
    if email != ALLOWED_EMAIL or not verify_password(request.password):
        record_login_failure(ip)
        raise HTTPException(401, "Email hoặc mật khẩu không đúng")
    clear_login_attempts(ip)
    response.set_cookie(
        SESSION_COOKIE,
        create_session(email),
        max_age=SESSION_TTL_SECONDS,
        httponly=True,
        samesite="lax",
    )
    return {"user": {"email": email}}


@app.post("/api/auth/logout")
def auth_logout(response: Response) -> dict:
    response.delete_cookie(SESSION_COOKIE)
    return {"ok": True}


@app.get("/api/accounts")
def get_accounts() -> dict:
    a, b = accounts.list("A"), accounts.list("B")
    public_a = [public_account(x, x.email.casefold() == accounts.active_a.casefold()) for x in a]
    public_b = [public_account(x) for x in b]
    flat = [{**item, "role": "A"} for item in public_a] + [{**item, "role": "B"} for item in public_b]
    return {"A": public_a, "B": public_b, "active_a": accounts.active_a or None, "accounts": flat}


@app.post("/api/accounts/oauth", status_code=202)
def begin_oauth(request: OAuthRequest) -> dict:
    if not CREDENTIALS.is_file():
        raise HTTPException(400, "credentials.json is missing")
    with oauth_lock:
        # Supersede any in-flight login instead of rejecting: an abandoned tab
        # would otherwise wedge every later attempt with a 409. Signal the old
        # worker to stop and mark its run cancelled.
        for rid, run in oauth_runs.items():
            if run["status"] in {"queued", "waiting_for_login"}:
                stale = oauth_sessions.get(rid)
                if stale is not None:
                    stale["cancelled"] = True
                run.update(status="cancelled", message="Da bi thay the boi phien dang nhap moi",
                    finished_at=now())
        oid = uuid.uuid4().hex
        oauth_runs[oid] = {"id": oid, "role": request.role, "status": "queued",
            "message": "Opening Google login", "email": None, "created_at": now(), "finished_at": None}
    try:
        flow, server, callback, authorization_url = create_oauth_session()
    except Exception as exc:
        with oauth_lock:
            oauth_runs.pop(oid, None)
        raise HTTPException(500, str(exc)) from exc
    with oauth_lock:
        oauth_sessions[oid] = {"role": request.role, "flow": flow, "server": server,
            "callback": callback, "cancelled": False}
        oauth_runs[oid].update(status="waiting_for_login", message="Open Google login in this browser",
            authorization_url=authorization_url, url=authorization_url)
    threading.Thread(target=oauth_worker, args=(oid, request.role), daemon=True).start()
    return {"oauth_id": oid, "id": oid, "authorization_url": authorization_url, "url": authorization_url}


@app.get("/api/oauth/{oauth_id}")
def oauth_status(oauth_id: str) -> dict:
    with oauth_lock:
        if oauth_id not in oauth_runs:
            raise HTTPException(404, "OAuth request not found")
        return dict(oauth_runs[oauth_id])


@app.post("/api/accounts/{role}/{email}/activate")
def activate(role: str, email: str) -> dict:
    if role.upper() != "A":
        raise HTTPException(400, "Only account A can be activated")
    try:
        return public_account(accounts.activate(email), True)
    except KeyError:
        raise HTTPException(404, "Account A not found")
    except FileNotFoundError:
        raise HTTPException(400, "Account token is missing")


@app.delete("/api/accounts/{role}/{email}")
def delete_account(role: str, email: str) -> dict:
    role = role.upper()
    if role not in ("A", "B"):
        raise HTTPException(400, "Vai trò không hợp lệ (chỉ A hoặc B)")
    try:
        account = accounts.remove(role, email)
    except KeyError:
        raise HTTPException(404, f"Account {role} không tồn tại: {email}")
    return {"ok": True, "role": role, "email": account.email, "active_a": accounts.active_a or None}


@app.post("/api/jobs/transfer", status_code=202)
def transfer(request: TransferRequest) -> dict:
    owner, commands = validate_owner(request.owner_email), []
    for row in request.rows:
        folder_ids = validate_folders(owner, row.folders)
        receiver = accounts.get("B", row.receiver_email)
        if receiver is None:
            raise HTTPException(400, f"Account B is not registered: {row.receiver_email}")
        if request.mode == "consumer" and not request.dry_run and not Path(receiver.token_path).is_file():
            raise HTTPException(400, f"Account B token is missing: {row.receiver_email}")
        cmd = [sys.executable, "-u", str(TRANSFER_SCRIPT), "--folders", ",".join(folder_ids),
            "--to-email", receiver.email, "--owner-token", owner.token_path,
            "--mode", request.mode, "--transfer-scope", request.scope,
            "--workers", str(request.workers)]
        if request.mode == "consumer" and not request.dry_run:
            cmd += ["--accept-token", receiver.token_path, "--credentials", str(CREDENTIALS),
                "--reauth-accept-token"]
        if not request.recursive: cmd.append("--no-recursive")
        if request.no_notify: cmd.append("--no-notify")
        if request.verify: cmd.append("--verify")
        if request.dry_run: cmd.append("--dry-run")
        commands.append(cmd)
    job = start_job("transfer", commands)
    return {"job_id": job.id, "id": job.id, "type": job.kind, "status": job.status}


@app.post("/api/jobs/block", status_code=202)
def block(request: BlockRequest) -> dict:
    owner = validate_owner(request.owner_email)
    # A folder can mix files owned by different accounts, and the block flag can
    # only be set by each file's owner. Pass every registered account token
    # (owner first, so it scans) so protect_videos routes each file to its owner.
    token_paths: list[str] = [owner.token_path]
    for role in ("A", "B"):
        for account in accounts.list(role):
            if account.token_path not in token_paths and Path(account.token_path).is_file():
                token_paths.append(account.token_path)
    cmd = [sys.executable, "-u", str(PROTECT_SCRIPT), "block", "--workers", str(request.workers)]
    for token_path in token_paths: cmd += ["--token", token_path]
    folder_ids = list(dict.fromkeys(extract_folder_id(value) for value in request.folders))
    for folder_id in folder_ids: cmd += ["--folder-id", folder_id]
    if request.recursive: cmd.append("--recursive")
    if request.unblock: cmd.append("--unblock")
    if request.target: cmd += ["--target", request.target]
    if request.dry_run: cmd.append("--dry-run")
    job = start_job("unblock" if request.unblock else "block", [cmd])
    return {"job_id": job.id, "id": job.id, "type": job.kind, "status": job.status}


@app.post("/api/jobs/copy-drive", status_code=202)
def copy_drive(request: CopyDriveRequest) -> dict:
    owner = validate_owner(request.owner_email)
    try:
        source_ids = list(dict.fromkeys(extract_folder_id(value) for value in request.sources))
        dest_id = extract_folder_id(request.dest)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    if not source_ids:
        raise HTTPException(422, "Cần ít nhất một link/id nguồn")
    try:
        service = build_drive_service(owner.token_path)
        if get_file(service, dest_id).mime_type != FOLDER_MIME_TYPE:
            raise HTTPException(422, f"Drive đích không phải folder: {dest_id}")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(400, "Không truy cập được folder đích bằng account A đã chọn") from exc

    cmd = [
        sys.executable,
        "-u",
        str(COPY_DRIVE_SCRIPT),
        "--sources",
        ",".join(source_ids),
        "--dest",
        dest_id,
        "--owner-token",
        owner.token_path,
        "--workers",
        str(request.workers),
        "--sort",
        request.sort,
        "--filter-mode",
        request.filter_mode,
        "--file-extensions",
        ",".join(request.file_extensions),
        "--video-extensions",
        ",".join(request.video_extensions),
        "--exclude",
        request.exclude,
    ]
    if not request.recursive:
        cmd.append("--no-recursive")
    if not request.checkpoint:
        cmd.append("--no-checkpoint")
    if request.dry_run:
        cmd.append("--dry-run")
    job = start_job("copy-drive", [cmd])
    return {"job_id": job.id, "id": job.id, "type": job.kind, "status": job.status}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str, after: int = 0) -> dict:
    with jobs_lock: job = jobs.get(job_id)
    if not job: raise HTTPException(404, "Job not found")
    return job.public(after)


@app.post("/api/jobs/{job_id}/stop")
def stop_job(job_id: str) -> dict:
    with jobs_lock: job = jobs.get(job_id)
    if not job: raise HTTPException(404, "Job not found")
    job.stop()
    return job.public()


if WEB_DIST.is_dir():
    if (WEB_DIST / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def frontend(path: str):
        candidate = (WEB_DIST / path).resolve()
        try: candidate.relative_to(WEB_DIST.resolve())
        except ValueError: candidate = WEB_DIST / "index.html"
        return FileResponse(candidate if candidate.is_file() else WEB_DIST / "index.html")


def main() -> None:
    import uvicorn
    host, port = os.getenv("OWNER_TOOL_HOST", "127.0.0.1"), int(os.getenv("OWNER_TOOL_PORT", "8765"))
    if os.getenv("OWNER_TOOL_NO_BROWSER", "").lower() not in {"1", "true", "yes"}:
        threading.Thread(target=lambda: (time.sleep(1), webbrowser.open(f"http://{host}:{port}")), daemon=True).start()
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    main()
