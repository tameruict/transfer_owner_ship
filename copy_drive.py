"""Copy Google Drive files/folders into another Drive folder.

This is the web/CLI version of the Colab "DriveAllInOne" copy cell. It keeps
the same operational ideas:
  * copy Drive-to-Drive with files.copy (no local download/upload),
  * keep a .clone_checkpoint.json in the destination folder,
  * skip files that the selected account cannot copy,
  * preserve folder structure,
  * write CSV reports for success/error/blocked rows.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sys
import threading
from collections.abc import Iterable, Mapping
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from googleapiclient.errors import HttpError
from googleapiclient.http import MediaIoBaseDownload, MediaIoBaseUpload

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from auto_transfer_videos import extract_folder_id
from drive_common import FOLDER_MIME_TYPE, SHORTCUT_MIME_TYPE, drive_query_literal
from transfer_ownership import (
    OAuthTokenError,
    ServiceFactory,
    execute_with_retry,
    get_authenticated_email,
)


GOOGLE_APP_MIME_PREFIX = "application/vnd.google-apps."
CHECKPOINT_NAME = ".clone_checkpoint.json"
DEFAULT_FILE_EXTENSIONS = (
    ".pdf",
    ".doc",
    ".docx",
    ".rtf",
    ".txt",
    ".ppt",
    ".pptx",
    ".xls",
    ".xlsx",
    ".csv",
    ".mp3",
    ".wav",
    ".m4a",
    ".aac",
)
DEFAULT_VIDEO_EXTENSIONS = (
    ".mp4",
    ".mov",
    ".mkv",
    ".avi",
    ".webm",
    ".m4v",
    ".wmv",
    ".flv",
    ".mpeg",
    ".mpg",
)


@dataclass(frozen=True)
class DriveEntry:
    id: str
    name: str
    mime_type: str
    size: str = ""
    can_copy: bool = True


def parse_link_list(raw: str) -> list[str]:
    ids: list[str] = []
    seen: set[str] = set()
    for chunk in re.split(r"[\n,]+", raw or ""):
        text = chunk.strip()
        if not text:
            continue
        item_id = extract_folder_id(text)
        if item_id not in seen:
            seen.add(item_id)
            ids.append(item_id)
    return ids


def parse_extensions(raw: str | Iterable[str] | None) -> set[str]:
    values: Iterable[str]
    if raw is None:
        values = []
    elif isinstance(raw, str):
        values = re.split(r"[\s,;]+", raw)
    else:
        values = raw
    extensions: set[str] = set()
    for item in values:
        ext = str(item or "").strip().casefold()
        if not ext:
            continue
        if not ext.startswith("."):
            ext = f".{ext}"
        extensions.add(ext)
    return extensions


def payload_to_entry(payload: Mapping[str, Any]) -> DriveEntry:
    capabilities = payload.get("capabilities") or {}
    can_copy = capabilities.get("canCopy")
    return DriveEntry(
        id=str(payload.get("id", "")),
        name=str(payload.get("name", "")),
        mime_type=str(payload.get("mimeType", "")),
        size=str(payload.get("size", "")),
        can_copy=True if can_copy is None else bool(can_copy),
    )


class DriveCopyRunner:
    def __init__(
        self,
        *,
        token_path: str,
        source_ids: list[str],
        dest_id: str,
        workers: int,
        recursive: bool,
        exclude_text: str,
        sort: str,
        filter_mode: str,
        file_extensions: set[str],
        video_extensions: set[str],
        checkpoint: bool,
        dry_run: bool,
        report_dir: Path,
    ) -> None:
        self.service_factory = ServiceFactory(token_path)
        self.source_ids = source_ids
        self.dest_id = dest_id
        self.workers = max(1, min(int(workers or 1), 16))
        self.recursive = recursive
        self.exclude_terms = [x.strip().casefold() for x in re.split(r"[,;\n]+", exclude_text or "") if x.strip()]
        self.sort = sort if sort in {"name", "stt"} else "name"
        self.filter_mode = filter_mode if filter_mode in {"all", "files", "videos", "custom"} else "all"
        self.file_extensions = file_extensions or set(DEFAULT_FILE_EXTENSIONS)
        self.video_extensions = video_extensions or set(DEFAULT_VIDEO_EXTENSIONS)
        self.checkpoint = checkpoint
        self.dry_run = dry_run
        self.report_dir = report_dir
        self.lock = threading.RLock()
        self.processed_ids: set[str] = set()
        self.checkpoint_file_id: str | None = None
        self.success_rows: list[dict[str, Any]] = []
        self.error_rows: list[dict[str, Any]] = []
        self.blocked_rows: list[dict[str, Any]] = []

    def service(self):
        return self.service_factory.get()

    def get_item(self, item_id: str) -> DriveEntry:
        payload = execute_with_retry(
            self.service().files().get(
                fileId=item_id,
                fields="id,name,mimeType,size,capabilities(canCopy)",
                supportsAllDrives=True,
            )
        )
        return payload_to_entry(payload)

    def list_children(self, folder_id: str) -> list[DriveEntry]:
        items: list[DriveEntry] = []
        page_token = None
        while True:
            payload = execute_with_retry(
                self.service().files().list(
                    q=f"'{drive_query_literal(folder_id)}' in parents and trashed=false",
                    fields="nextPageToken,files(id,name,mimeType,size,capabilities(canCopy))",
                    pageSize=1000,
                    pageToken=page_token,
                    supportsAllDrives=True,
                    includeItemsFromAllDrives=True,
                )
            )
            items.extend(payload_to_entry(item) for item in payload.get("files", []))
            page_token = payload.get("nextPageToken")
            if not page_token:
                return items

    def load_checkpoint(self) -> None:
        if not self.checkpoint:
            print("[checkpoint] Disabled.")
            return
        try:
            payload = execute_with_retry(
                self.service().files().list(
                    q=(
                        f"'{drive_query_literal(self.dest_id)}' in parents and "
                        f"name='{drive_query_literal(CHECKPOINT_NAME)}' and trashed=false"
                    ),
                    fields="files(id,name)",
                    pageSize=1,
                    supportsAllDrives=True,
                    includeItemsFromAllDrives=True,
                )
            )
            files = payload.get("files", [])
            if not files:
                print("[checkpoint] No previous checkpoint found.")
                return
            self.checkpoint_file_id = files[0]["id"]
            request = self.service().files().get_media(fileId=self.checkpoint_file_id)
            buffer = io.BytesIO()
            downloader = MediaIoBaseDownload(buffer, request)
            done = False
            while not done:
                _, done = downloader.next_chunk()
            loaded = json.loads(buffer.getvalue().decode("utf-8") or "[]")
            self.processed_ids = {str(item) for item in loaded}
            print(f"[checkpoint] Loaded {len(self.processed_ids)} copied source id(s).")
        except Exception as exc:  # noqa: BLE001 - checkpoint should never block copy
            print(f"[WARN] checkpoint load failed, starting fresh: {exc}")

    def save_checkpoint(self) -> None:
        if not self.checkpoint or self.dry_run or not self.processed_ids:
            return
        try:
            data = json.dumps(sorted(self.processed_ids)).encode("utf-8")
            media = MediaIoBaseUpload(io.BytesIO(data), mimetype="application/json", resumable=True)
            if self.checkpoint_file_id:
                execute_with_retry(self.service().files().update(fileId=self.checkpoint_file_id, media_body=media))
            else:
                payload = execute_with_retry(
                    self.service().files().create(
                        body={"name": CHECKPOINT_NAME, "parents": [self.dest_id]},
                        media_body=media,
                        fields="id",
                        supportsAllDrives=True,
                    )
                )
                self.checkpoint_file_id = payload["id"]
            print(f"[checkpoint] Saved {len(self.processed_ids)} copied source id(s).")
        except Exception as exc:  # noqa: BLE001
            print(f"[WARN] checkpoint save failed: {exc}")

    def excluded_by_name(self, name: str) -> bool:
        lowered = name.casefold()
        return any(term in lowered for term in self.exclude_terms)

    def allowed_file(self, item: DriveEntry) -> bool:
        if self.filter_mode == "all":
            return item.mime_type != SHORTCUT_MIME_TYPE
        name = item.name.casefold()
        is_video_mime = item.mime_type.startswith("video/")
        is_google_doc = item.mime_type.startswith(GOOGLE_APP_MIME_PREFIX)
        if self.filter_mode == "videos":
            return is_video_mime or any(name.endswith(ext) for ext in self.video_extensions)
        if self.filter_mode == "files":
            if is_video_mime:
                return False
            return is_google_doc or any(name.endswith(ext) for ext in self.file_extensions)
        if self.filter_mode == "custom":
            allowed = self.file_extensions | self.video_extensions
            return bool(allowed) and any(name.endswith(ext) for ext in allowed)
        return True

    def find_existing(self, parent_id: str, name: str, mime_type: str | None = None) -> str | None:
        q = f"'{drive_query_literal(parent_id)}' in parents and name='{drive_query_literal(name)}' and trashed=false"
        if mime_type:
            q += f" and mimeType='{drive_query_literal(mime_type)}'"
        payload = execute_with_retry(
            self.service().files().list(
                q=q,
                fields="files(id,name)",
                pageSize=1,
                supportsAllDrives=True,
                includeItemsFromAllDrives=True,
            )
        )
        files = payload.get("files", [])
        return str(files[0]["id"]) if files else None

    def create_folder(self, parent_id: str, name: str) -> str:
        existing = self.find_existing(parent_id, name, FOLDER_MIME_TYPE)
        if existing:
            return existing
        if self.dry_run:
            print(f"[DRY]  folder {name}")
            return parent_id
        payload = execute_with_retry(
            self.service().files().create(
                body={"name": name, "mimeType": FOLDER_MIME_TYPE, "parents": [parent_id]},
                fields="id",
                supportsAllDrives=True,
            )
        )
        print(f"[OK]   folder {name}")
        return str(payload["id"])

    def copy_file(self, item: DriveEntry, dest_id: str) -> str | None:
        if item.id in self.processed_ids:
            print(f"[skip] checkpoint {item.name}")
            return None
        if self.dry_run:
            print(f"[DRY]  copy {item.name}")
            return f"dry-file:{item.id}"
        existing = self.find_existing(dest_id, item.name)
        if existing:
            print(f"[skip] exists {item.name}")
            with self.lock:
                self.processed_ids.add(item.id)
            return existing
        payload = execute_with_retry(
            self.service().files().copy(
                fileId=item.id,
                body={"name": item.name, "parents": [dest_id]},
                fields="id",
                supportsAllDrives=True,
            )
        )
        new_id = str(payload["id"])
        with self.lock:
            self.processed_ids.add(item.id)
        print(f"[OK]   file {item.name}")
        return new_id

    def record_success(self, index: int, item: DriveEntry, item_type: str, new_id: str) -> None:
        with self.lock:
            self.success_rows.append(
                {
                    "STT_Goc": index + 1,
                    "Ten_File_Folder": item.name,
                    "Loai": item_type,
                    "Link_Goc": f"https://drive.google.com/open?id={item.id}",
                    "Link_Dich_Moi": f"https://drive.google.com/open?id={new_id}",
                }
            )

    def record_error(self, item: DriveEntry | str, item_type: str, reason: str) -> None:
        if isinstance(item, DriveEntry):
            row = {"Ten_File_Folder": item.name, "Loai": item_type, "ID_Nguon": item.id, "Ly_do_loi": reason}
        else:
            row = {"Ten_File_Folder": item, "Loai": item_type, "ID_Nguon": "", "Ly_do_loi": reason}
        with self.lock:
            self.error_rows.append(row)
        print(f"[ERR]  {row['Ten_File_Folder']}: {reason}", file=sys.stderr)

    def record_blocked(self, item: DriveEntry) -> None:
        with self.lock:
            self.blocked_rows.append(
                {
                    "Ten_File": item.name,
                    "Link_Goc_Chi_Xem": f"https://drive.google.com/open?id={item.id}",
                }
            )
        print(f"[WARN] blocked/cannot copy {item.name}")

    def copy_tree(self, item: DriveEntry, dest_id: str) -> None:
        for child in self.list_children(item.id):
            if self.excluded_by_name(child.name):
                print(f"[skip] excluded {child.name}")
                continue
            if child.mime_type == FOLDER_MIME_TYPE:
                if not self.recursive:
                    continue
                child_dest = self.create_folder(dest_id, child.name)
                self.copy_tree(child, child_dest)
                continue
            if not self.allowed_file(child):
                continue
            if not child.can_copy:
                self.record_blocked(child)
                continue
            try:
                self.copy_file(child, dest_id)
            except HttpError as exc:
                self.record_error(child, "File", str(exc))

    def process_source(self, index: int, source_id: str) -> None:
        try:
            item = self.get_item(source_id)
        except Exception as exc:  # noqa: BLE001
            self.record_error(f"ID: {source_id}", "Unknown", f"Cannot access source: {exc}")
            return

        print(f"[scan] [{index + 1}/{len(self.source_ids)}] {item.name}")
        if self.excluded_by_name(item.name):
            print(f"[skip] excluded source {item.name}")
            return

        try:
            if item.mime_type == FOLDER_MIME_TYPE:
                new_id = self.create_folder(self.dest_id, item.name)
                self.copy_tree(item, new_id)
                self.record_success(index, item, "Folder", new_id)
                return
            if not self.allowed_file(item):
                print(f"[skip] filtered {item.name}")
                return
            if not item.can_copy:
                self.record_blocked(item)
                return
            new_id = self.copy_file(item, self.dest_id)
            if new_id:
                self.record_success(index, item, "File", new_id)
        except Exception as exc:  # noqa: BLE001
            self.record_error(item, "Folder" if item.mime_type == FOLDER_MIME_TYPE else "File", str(exc))

    def write_csv(self, filename: str, rows: list[dict[str, Any]], columns: list[str]) -> Path | None:
        if not rows:
            return None
        self.report_dir.mkdir(parents=True, exist_ok=True)
        path = self.report_dir / filename
        with path.open("w", newline="", encoding="utf-8-sig") as handle:
            writer = csv.DictWriter(handle, fieldnames=columns)
            writer.writeheader()
            writer.writerows(rows)
        print(f"[report] {path}")
        return path

    def write_reports(self) -> None:
        success_rows = list(self.success_rows)
        if self.sort == "name":
            success_rows.sort(key=lambda row: str(row.get("Ten_File_Folder", "")).casefold())
        for number, row in enumerate(success_rows, start=1):
            row["STT_Moi"] = number
        self.write_csv(
            "Bao_Cao_Clone_Drive.csv",
            success_rows,
            ["STT_Moi", "STT_Goc", "Ten_File_Folder", "Loai", "Link_Goc", "Link_Dich_Moi"],
        )
        self.write_csv(
            "Loi_Copy_Drive.csv",
            self.error_rows,
            ["Ten_File_Folder", "Loai", "ID_Nguon", "Ly_do_loi"],
        )
        self.write_csv(
            "Danh_Sach_Bi_Chan_Tai.csv",
            self.blocked_rows,
            ["Ten_File", "Link_Goc_Chi_Xem"],
        )

    def run(self) -> int:
        service = self.service()
        dest = execute_with_retry(
            service.files().get(fileId=self.dest_id, fields="id,name,mimeType", supportsAllDrives=True)
        )
        if dest.get("mimeType") != FOLDER_MIME_TYPE:
            raise SystemExit(f"Destination is not a folder: {self.dest_id}")
        email = get_authenticated_email(service)
        print(
            f"Copy Drive job · account={email or 'unknown'} · sources={len(self.source_ids)} "
            f"· dest={dest.get('name')} · filter={self.filter_mode} · workers={self.workers} · dry_run={self.dry_run}"
        )
        self.load_checkpoint()
        with ThreadPoolExecutor(max_workers=self.workers) as executor:
            futures = [
                executor.submit(self.process_source, index, source_id)
                for index, source_id in enumerate(self.source_ids)
            ]
            for future in as_completed(futures):
                future.result()
        self.save_checkpoint()
        self.write_reports()
        print(
            "Done. copied_roots={copied} blocked={blocked} errors={errors} checkpoint={checkpoint}".format(
                copied=len(self.success_rows),
                blocked=len(self.blocked_rows),
                errors=len(self.error_rows),
                checkpoint=len(self.processed_ids),
            )
        )
        return 1 if self.error_rows else 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Copy Google Drive items into a destination folder.")
    parser.add_argument("--sources", required=True, help="Comma/newline separated source URLs or IDs")
    parser.add_argument("--dest", required=True, help="Destination folder URL or ID")
    parser.add_argument("--owner-token", required=True, help="OAuth token JSON for the selected account A")
    parser.add_argument("--workers", type=int, default=10)
    parser.add_argument("--no-recursive", action="store_true")
    parser.add_argument("--exclude", default="", help="Comma/newline separated keywords to skip by name")
    parser.add_argument("--sort", choices=("name", "stt"), default="name")
    parser.add_argument("--filter-mode", choices=("all", "files", "videos", "custom"), default="all")
    parser.add_argument("--file-extensions", default=",".join(DEFAULT_FILE_EXTENSIONS))
    parser.add_argument("--video-extensions", default=",".join(DEFAULT_VIDEO_EXTENSIONS))
    parser.add_argument("--no-checkpoint", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--report-dir", default="")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    source_ids = parse_link_list(args.sources)
    dest_ids = parse_link_list(args.dest)
    if not source_ids:
        raise SystemExit("No source Drive links/ids were provided.")
    if not dest_ids:
        raise SystemExit("No destination Drive folder link/id was provided.")
    report_root = Path(args.report_dir) if args.report_dir else Path("reports") / f"copy_drive_{datetime.now():%Y%m%d_%H%M%S}"
    try:
        runner = DriveCopyRunner(
            token_path=args.owner_token,
            source_ids=source_ids,
            dest_id=dest_ids[0],
            workers=args.workers,
            recursive=not args.no_recursive,
            exclude_text=args.exclude,
            sort=args.sort,
            filter_mode=args.filter_mode,
            file_extensions=parse_extensions(args.file_extensions),
            video_extensions=parse_extensions(args.video_extensions),
            checkpoint=not args.no_checkpoint,
            dry_run=args.dry_run,
            report_dir=report_root,
        )
        return runner.run()
    except OAuthTokenError as exc:
        print(f"[AUTH ERR] {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
