"""GitHub Actions runner for Owner Video Tool jobs.

Reads a job payload (JSON, from env GHA_JOB_PAYLOAD), loads the encrypted Google
OAuth token bundle from Upstash/Vercel KV, materializes each token to a temp file,
then runs the existing CLI
(auto_transfer_videos.py / protect_videos.py) once per row.

Tokens never touch the repo: they are written to a temp dir that the runner VM
discards when the job ends. stdout is streamed and captured by GitHub Actions.
"""
import base64
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ROOT = pathlib.Path(__file__).resolve().parent.parent

KV_KEY = "owner-video-tool:accounts"


def log(message):
    print(message, flush=True)


def _kv_url():
    return (os.environ.get("KV_REST_API_URL") or os.environ.get("UPSTASH_REDIS_REST_URL") or "").strip().rstrip("/")


def _kv_token():
    return (
        os.environ.get("KV_REST_API_READ_ONLY_TOKEN")
        or os.environ.get("UPSTASH_REDIS_REST_READONLY_TOKEN")
        or os.environ.get("KV_REST_API_TOKEN")
        or os.environ.get("UPSTASH_REDIS_REST_TOKEN")
        or ""
    ).strip()


def _store_key():
    return (os.environ.get("OWNER_TOOL_STORE_KEY") or os.environ.get("OWNER_TOOL_KV_ENCRYPTION_KEY") or "").strip()


def _account_key():
    return (os.environ.get("OWNER_TOOL_KV_KEY") or os.environ.get("OWNER_TOOL_ACCOUNTS_KEY") or KV_KEY).strip()


def _b64url_decode(value):
    raw = str(value or "").encode("utf-8")
    raw += b"=" * (-len(raw) % 4)
    return base64.urlsafe_b64decode(raw)


def _decrypt_bundle(raw):
    if not raw:
        return {"version": 1, "active_a": "", "A": [], "B": []}
    try:
        envelope = json.loads(raw) if isinstance(raw, str) else raw
        if not envelope.get("encrypted"):
            raise ValueError("KV account store chưa được mã hóa.")
        if envelope.get("version") != 2 or envelope.get("algorithm") != "aes-256-gcm":
            raise ValueError("Định dạng KV account store không được hỗ trợ.")
        key = hashlib.sha256(_store_key().encode("utf-8")).digest()
        aesgcm = AESGCM(key)
        plaintext = aesgcm.decrypt(
            _b64url_decode(envelope.get("iv")),
            _b64url_decode(envelope.get("data")) + _b64url_decode(envelope.get("tag")),
            None,
        )
        bundle = json.loads(plaintext.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(f"Không giải mã được KV account store: {exc}")
    return {
        "version": 1,
        "active_a": str(bundle.get("active_a") or bundle.get("active_email") or "").strip(),
        "A": bundle.get("A") if isinstance(bundle.get("A"), list) else [],
        "B": bundle.get("B") if isinstance(bundle.get("B"), list) else [],
    }


def _kv_command(command, *args):
    body = json.dumps([command, *args]).encode("utf-8")
    request = urllib.request.Request(
        _kv_url(),
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {_kv_token()}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            data = json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"Đọc KV token lỗi (HTTP {exc.code}): {detail}")
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(f"Đọc KV token lỗi: {exc}")
    if data.get("error"):
        raise SystemExit(f"Đọc KV token lỗi: {data['error']}")
    return data.get("result")


def load_bundle_from_kv():
    """Fetch and decrypt the live token bundle from Upstash/Vercel KV.

    Returns None when KV isn't configured so local/legacy setups can still use
    OWNER_TOOL_ACCOUNTS_JSON_B64 as a fallback.
    """
    if not _kv_url() or not _kv_token() or not _store_key():
        return None
    return _decrypt_bundle(_kv_command("GET", _account_key()))


def load_bundle():
    bundle = load_bundle_from_kv()
    if bundle is not None:
        log("Token bundle: đọc từ encrypted KV store.")
        return bundle
    raw = os.environ.get("OWNER_TOOL_ACCOUNTS_JSON_B64", "").strip()
    if not raw:
        raise SystemExit("Thiếu KV_REST_API_URL/KV token/OWNER_TOOL_STORE_KEY hoặc OWNER_TOOL_ACCOUNTS_JSON_B64 fallback.")
    try:
        log("Token bundle: đọc từ secret OWNER_TOOL_ACCOUNTS_JSON_B64 (fallback).")
        return json.loads(base64.b64decode(raw).decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(f"OWNER_TOOL_ACCOUNTS_JSON_B64 không hợp lệ: {exc}")


def materialize_tokens(bundle):
    """Write each account token to a temp file. Returns {(role, email): path}."""
    root = pathlib.Path(tempfile.mkdtemp(prefix="gha_tokens_"))
    paths = {}
    for role in ("A", "B"):
        for acc in bundle.get(role, []) or []:
            email = str(acc.get("email", "")).strip()
            token_b64 = acc.get("token_b64")
            if not email or not token_b64:
                continue
            safe = email.replace("@", "_at_").replace("/", "_")
            target = root / f"{role}_{safe}.json"
            target.write_bytes(base64.b64decode(token_b64))
            paths[(role, email.lower())] = str(target)
    return paths


def token_path(paths, role, email):
    path = paths.get((role, str(email).strip().lower()))
    if not path:
        raise SystemExit(f"Không tìm thấy token cho account {role}: {email}")
    return path


def _workers(payload):
    """Clamp the requested worker count to a safe 1..16 range (default 4)."""
    try:
        return max(1, min(int(payload.get("workers", 4)), 16))
    except (TypeError, ValueError):
        return 4


def run(cmd):
    log("$ " + " ".join(cmd[2:]))  # skip python -u for readability
    return subprocess.call(cmd, cwd=str(ROOT))


def run_transfer(payload, paths):
    owner_email = payload["owner_email"]
    owner_token = token_path(paths, "A", owner_email)
    mode = payload.get("mode", "consumer")
    scope = payload.get("scope", "videos")
    rows = payload.get("rows", [])
    if not rows:
        raise SystemExit("Payload transfer không có dòng nào.")
    failures = 0
    for index, row in enumerate(rows, start=1):
        to_email = row["receiver_email"]
        folders = ",".join(row.get("folders", []))
        if not folders:
            log(f"[skip] Dòng {index} ({to_email}) không có folder.")
            failures += 1
            continue
        cmd = [
            sys.executable, "-u", "auto_transfer_videos.py",
            "--folders", folders,
            "--to-email", to_email,
            "--owner-token", owner_token,
            "--mode", mode,
            "--transfer-scope", scope,
            "--workers", str(_workers(payload)),
        ]
        if mode == "consumer" and not payload.get("dry_run"):
            cmd += ["--accept-token", token_path(paths, "B", to_email),
                    "--credentials", "credentials.json"]
        if payload.get("no_recursive"):
            cmd += ["--no-recursive"]
        if payload.get("no_notify"):
            cmd += ["--no-notify"]
        if payload.get("verify"):
            cmd += ["--verify"]
        if payload.get("dry_run"):
            cmd += ["--dry-run"]
        log(f"::group::[{index}/{len(rows)}] Transfer {owner_email} -> {to_email}")
        code = run(cmd)
        log("::endgroup::")
        if code != 0:
            failures += 1
            log(f"::warning::Dòng {index} ({to_email}) trả về mã lỗi {code}.")
    return failures


def run_block(payload, paths):
    owner_token = token_path(paths, "A", payload["owner_email"])
    folders = payload.get("folders", [])
    if not folders:
        raise SystemExit("Payload block không có folder nào.")
    # A folder can mix files owned by different accounts, and the block flag can
    # only be set by each file's owner. Pass every materialized account token
    # (owner first, so it scans) so protect_videos routes each file to its owner.
    token_paths = [owner_token]
    for path in paths.values():
        if path not in token_paths:
            token_paths.append(path)
    cmd = [sys.executable, "-u", "protect_videos.py", "block",
           "--workers", str(_workers(payload))]
    for path in token_paths:
        cmd += ["--token", path]
    for fid in folders:
        cmd += ["--folder-id", fid]
    if payload.get("recursive"):
        cmd += ["--recursive"]
    if payload.get("unblock"):
        cmd += ["--unblock"]
    if payload.get("target") in {"videos", "files", "sheets"}:
        cmd += ["--target", payload["target"]]
    if payload.get("dry_run"):
        cmd += ["--dry-run"]
    action = "UNBLOCK" if payload.get("unblock") else "BLOCK"
    log(f"::group::{action} {len(folders)} folder(s)")
    code = run(cmd)
    log("::endgroup::")
    return 1 if code else 0


def run_copy_drive(payload, paths):
    owner_token = token_path(paths, "A", payload["owner_email"])
    sources = payload.get("sources", [])
    dest = payload.get("dest", "")
    if not sources or not dest:
        raise SystemExit("Payload copy-drive thiếu sources hoặc dest.")
    cmd = [
        sys.executable,
        "-u",
        "copy_drive.py",
        "--sources",
        ",".join(sources),
        "--dest",
        dest,
        "--owner-token",
        owner_token,
        "--workers",
        str(_workers(payload)),
        "--sort",
        payload.get("sort", "name"),
        "--filter-mode",
        payload.get("filter_mode", "all"),
        "--file-extensions",
        ",".join(payload.get("file_extensions", []) or []),
        "--video-extensions",
        ",".join(payload.get("video_extensions", []) or []),
        "--exclude",
        payload.get("exclude", ""),
    ]
    if not payload.get("recursive", True):
        cmd += ["--no-recursive"]
    if not payload.get("checkpoint", True):
        cmd += ["--no-checkpoint"]
    if payload.get("dry_run"):
        cmd += ["--dry-run"]
    log(f"::group::COPY DRIVE {len(sources)} source(s)")
    code = run(cmd)
    log("::endgroup::")
    return 1 if code else 0


def main():
    raw_payload = os.environ.get("GHA_JOB_PAYLOAD", "").strip()
    if not raw_payload:
        raise SystemExit("Thiếu GHA_JOB_PAYLOAD.")
    payload = json.loads(raw_payload)
    kind = os.environ.get("GHA_JOB_KIND", "transfer").strip() or "transfer"

    bundle = load_bundle()
    paths = materialize_tokens(bundle)

    log(f"Owner Video Tool · GitHub Actions runner · kind={kind} dry_run={bool(payload.get('dry_run'))}")
    if kind == "transfer":
        failures = run_transfer(payload, paths)
    elif kind == "copy-drive":
        failures = run_copy_drive(payload, paths)
    else:
        failures = run_block(payload, paths)

    if failures:
        log(f"Hoàn tất với {failures} lỗi.")
        return 1
    log("Hoàn tất, không lỗi.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
