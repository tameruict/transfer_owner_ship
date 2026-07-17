"""Protect course videos across subject folders (Toán / Lý / Hóa ...).

Two operations on the VIDEO files found inside one or more Drive folders
(optionally scanned recursively):

  transfer  Move ownership of every video from account A to account B.
            Reuses the consumer (pending-owner) or workspace (direct) flow
            from transfer_ownership.py.

  block     Set or remove Google Drive's download restriction on videos or
            all files. This controls Download / Copy / Print for non-owners
            (readers, commenters and writers). Owners are unaffected.

IMPORTANT ordering note
-----------------------
The download restriction can only be set by the file's OWNER. Once account A transfers a
video to account B, account A can no longer block it. So either:
  * run `block` with account A BEFORE transferring (the flag survives the
    ownership change and keeps protecting the file under B), or
  * run `block` with account B's token AFTER the transfer.

Mixed owners in one folder
--------------------------
A single folder often holds files owned by several accounts. Pass a --token for
each owner: every file is routed to the token of its actual owner, so one run
blocks the whole folder no matter who owns each file. Files whose owner has no
matching token are skipped with a clear message instead of failing on HTTP 403.

Examples
--------
  # 1) Block download on A's videos in three subject folders (recursive):
  python protect_videos.py block \
      --token token_A.json --recursive \
      --folder-id <TOAN_ID> --folder-id <LY_ID> --folder-id <HOA_ID>

  # 1b) Same folders, files owned by A, B and C mixed together:
  python protect_videos.py block \
      --token token_A.json --token token_B.json --token token_C.json \
      --recursive --folder-id <TOAN_ID> --folder-id <LY_ID> --folder-id <HOA_ID>

  # 2) Transfer those same videos from A to B (consumer Gmail, auto-accept):
  python protect_videos.py transfer \
      --owner-token token_A.json --accept-token tools/ownership/token_B.json \
      --to-email accountB@gmail.com --recursive \
      --folder-id <TOAN_ID> --folder-id <LY_ID> --folder-id <HOA_ID>

  # Preview first — nothing is changed:
  python protect_videos.py transfer ... --dry-run
"""

from __future__ import annotations

import argparse
import sys
import time
from collections import deque
from collections.abc import Callable, Iterable
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from pathlib import Path

# Windows consoles default to cp1252, which cannot encode Vietnamese file names
# (e.g. \u1ea7). Force UTF-8 so printing video titles never crashes.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

from googleapiclient.errors import HttpError

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from drive_common import FOLDER_MIME_TYPE, SHORTCUT_MIME_TYPE
from transfer_ownership import (
    DriveItem,
    ItemOutcome,
    OAuthTokenError,
    ServiceFactory,
    build_drive_service,
    describe_item_owners,
    execute_with_retry,
    get_authenticated_email,
    list_folder_children,
    get_file,
    owner_skip_reason,
    run_item_batch,
    transfer_consumer_owner,
    transfer_workspace_owner,
    _http_status,
)


GOOGLE_SHEETS_MIME_TYPE = "application/vnd.google-apps.spreadsheet"


def _error_hint(exc: HttpError) -> str:
    """A short, human-readable hint appended to error lines for common cases."""
    status = _http_status(exc)
    if status == 403:
        return (
            " (HTTP 403 — the token may not OWN this file; use the current "
            "owner's token to change its download restriction)"
        )
    if status == 404:
        return " (HTTP 404 — file not found or no access with this token)"
    return ""


def is_video(item: DriveItem) -> bool:
    """True for actual video files (mimeType video/*)."""
    return item.mime_type.startswith("video/")


def is_google_sheet(item: DriveItem) -> bool:
    """True for Google Sheets files."""
    return item.mime_type == GOOGLE_SHEETS_MIME_TYPE


def is_blockable_file(item: DriveItem) -> bool:
    """True for any real, downloadable file (not a folder or shortcut).

    This includes uploaded files and native Google files. Folders and shortcuts
    are excluded because Drive's item download restriction applies to files.
    """
    return item.mime_type not in (FOLDER_MIME_TYPE, SHORTCUT_MIME_TYPE)


BLOCK_TARGETS: dict[str, tuple[Callable[[DriveItem], bool], str]] = {
    "videos": (is_video, "video(s)"),
    "files": (is_blockable_file, "file(s)"),
    "sheets": (is_google_sheet, "sheet(s)"),
}


def collect_videos(
    service,
    folder_ids: Iterable[str],
    *,
    recursive: bool,
    max_depth: int | None = None,
    accept: Callable[[DriveItem], bool] = is_video,
) -> list[DriveItem]:
    """Return every matching file inside the given folders.

    ``accept`` decides which files are collected (videos only by default).
    Each folder id is walked breadth-first when recursive=True. Shortcuts and
    sub-folders are traversed for discovery but never collected themselves.
    ``max_depth`` limits recursive folder traversal below each root; files in a
    folder at that depth are still considered, but deeper sub-folders are not.
    """
    matches: list[DriveItem] = []
    seen_ids: set[str] = set()
    visited_folders: set[str] = set()

    for folder_id in folder_ids:
        root = get_file(service, folder_id)
        if root.mime_type != FOLDER_MIME_TYPE:
            # Caller pointed directly at a file; include it if it matches.
            if accept(root) and root.id not in seen_ids:
                seen_ids.add(root.id)
                matches.append(root)
            continue

        queue = deque([(root, 0)])
        while queue:
            folder, depth = queue.popleft()
            if folder.id in visited_folders:
                continue
            visited_folders.add(folder.id)
            if len(visited_folders) == 1 or len(visited_folders) % 50 == 0:
                print(
                    f"[scan] folders={len(visited_folders)} files so far={len(matches)}",
                    flush=True,
                )

            for child in list_folder_children(service, folder.id):
                if child.mime_type == FOLDER_MIME_TYPE:
                    if recursive and (max_depth is None or depth < max_depth):
                        queue.append((child, depth + 1))
                    continue
                if child.mime_type == SHORTCUT_MIME_TYPE:
                    continue
                if accept(child) and child.id not in seen_ids:
                    seen_ids.add(child.id)
                    matches.append(child)

    return matches


def collect_files_parallel(
    factories: Iterable[ServiceFactory],
    folder_ids: Iterable[str],
    *,
    recursive: bool,
    max_depth: int | None,
    accept: Callable[[DriveItem], bool],
    workers: int,
) -> list[DriveItem]:
    """Threaded folder discovery for large Drive trees.

    The Drive service object is not thread-safe, so workers obtain their own
    thread-local service from a factory before listing folder children. For
    every root/sub-folder, tokens are tried in order until one has access. This
    avoids failing the whole scan merely because the first valid token cannot
    see a folder that another supplied token can see.
    """
    factory_list = list(factories)
    if not factory_list:
        raise ValueError("At least one Drive service factory is required")
    matches: list[DriveItem] = []
    seen_files: set[str] = set()
    scheduled_folders: set[str] = set()
    pending: deque[tuple[ServiceFactory, DriveItem, int]] = deque()
    completed_folders = 0

    def add_match(item: DriveItem) -> None:
        if item.id not in seen_files and accept(item):
            seen_files.add(item.id)
            matches.append(item)

    def try_with_access(
        preferred: ServiceFactory,
        operation: Callable[[ServiceFactory], DriveItem | list[DriveItem]],
    ) -> tuple[ServiceFactory, DriveItem | list[DriveItem]]:
        candidates = [preferred, *(item for item in factory_list if item is not preferred)]
        last_access_error: HttpError | None = None
        for candidate in candidates:
            try:
                return candidate, operation(candidate)
            except HttpError as exc:
                if _http_status(exc) not in (403, 404):
                    raise
                last_access_error = exc
        assert last_access_error is not None
        raise last_access_error

    def get_root(folder_id: str) -> tuple[ServiceFactory, DriveItem]:
        factory, result = try_with_access(
            factory_list[0], lambda candidate: get_file(candidate.primary, folder_id)
        )
        assert isinstance(result, DriveItem)
        return factory, result

    def list_one(
        preferred: ServiceFactory, folder: DriveItem, depth: int
    ) -> tuple[ServiceFactory, DriveItem, int, list[DriveItem]]:
        factory, result = try_with_access(
            preferred,
            lambda candidate: list_folder_children(candidate.get(), folder.id),
        )
        assert isinstance(result, list)
        return factory, folder, depth, result

    for folder_id in folder_ids:
        factory, root = get_root(folder_id)
        if root.mime_type == FOLDER_MIME_TYPE:
            if root.id not in scheduled_folders:
                scheduled_folders.add(root.id)
                pending.append((factory, root, 0))
        else:
            add_match(root)

    max_workers = max(1, workers)
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures: dict[
            Future[tuple[ServiceFactory, DriveItem, int, list[DriveItem]]], None
        ] = {}

        def fill_pool() -> None:
            while pending and len(futures) < max_workers:
                factory, folder, depth = pending.popleft()
                futures[executor.submit(list_one, factory, folder, depth)] = None

        fill_pool()
        while futures:
            done, _ = wait(futures, return_when=FIRST_COMPLETED)
            for future in done:
                futures.pop(future, None)
                factory, folder, depth, children = future.result()
                completed_folders += 1
                if completed_folders == 1 or completed_folders % 50 == 0:
                    print(
                        f"[scan] folders={completed_folders} files so far={len(matches)}",
                        flush=True,
                    )

                for child in children:
                    if child.mime_type == FOLDER_MIME_TYPE:
                        if (
                            recursive
                            and (max_depth is None or depth < max_depth)
                            and child.id not in scheduled_folders
                        ):
                            scheduled_folders.add(child.id)
                            pending.append((factory, child, depth + 1))
                        continue
                    if child.mime_type == SHORTCUT_MIME_TYPE:
                        continue
                    add_match(child)

            fill_pool()

    return matches


# --------------------------------------------------------------------------- #
# transfer
# --------------------------------------------------------------------------- #


def run_transfer(args: argparse.Namespace) -> int:
    try:
        owner_service = build_drive_service(args.owner_token)
        accept_service = (
            build_drive_service(
                args.accept_token,
                reauth=args.reauth_accept_token,
                credentials_path=args.credentials,
                expected_email=args.to_email,
            )
            if args.accept_token and not args.dry_run
            else None
        )
    except OAuthTokenError as exc:
        print(f"[AUTH ERR] {exc}", file=sys.stderr)
        return 2

    if args.mode == "consumer" and accept_service is None:
        if args.dry_run:
            print(
                "[WARN] dry-run: account B token was not checked because no "
                "ownership accept calls will be made.",
                file=sys.stderr,
            )
        else:
            print(
                "[WARN] consumer mode without --accept-token only creates pending-owner "
                "requests; account B still has to accept them manually.",
                file=sys.stderr,
            )

    expected_owner_email = get_authenticated_email(owner_service)
    videos = collect_videos(
        owner_service,
        args.folder_id,
        recursive=args.recursive,
        max_depth=args.max_depth,
    )
    print(
        f"Found {len(videos)} video(s) across {len(args.folder_id)} folder(s). "
        f"mode={args.mode} owner_filter={expected_owner_email or 'unknown'} "
        f"dry_run={args.dry_run}"
    )

    success = skipped = failed = 0
    for index, item in enumerate(videos, start=1):
        if args.max_items is not None and index > args.max_items:
            break
        label = f"{item.name} ({item.id})"
        owner_reason = owner_skip_reason(
            item,
            expected_owner_email,
            already_owner_email=args.to_email,
        )
        if owner_reason:
            skipped += 1
            print(f"[SKIP] {label}: {owner_reason}")
            continue

        if args.dry_run:
            success += 1
            print(f"[DRY]  {label}")
            continue

        try:
            if args.mode == "workspace":
                transfer_workspace_owner(
                    owner_service, item.id, args.to_email, notify=not args.no_notify
                )
            else:
                transfer_consumer_owner(
                    owner_service,
                    accept_service,
                    item,
                    args.to_email,
                    notify=not args.no_notify,
                )
            success += 1
            print(f"[OK]   {label}")
        except HttpError as exc:
            failed += 1
            print(f"[ERR]  {label}: {exc}{_error_hint(exc)}", file=sys.stderr)

        if args.sleep > 0:
            time.sleep(args.sleep)

    print(f"Done. success={success}, skipped={skipped}, failed={failed}")
    return 1 if failed else 0


# --------------------------------------------------------------------------- #
# block
# --------------------------------------------------------------------------- #


def _download_restriction_payload(restricted: bool) -> dict:
    return {
        "downloadRestrictions": {
            "itemDownloadRestriction": {
                "restrictedForReaders": restricted,
                "restrictedForWriters": restricted,
            }
        }
    }


def _download_restriction_values(info: dict) -> tuple[bool, bool]:
    restrictions = info.get("downloadRestrictions") or {}
    effective = restrictions.get("effectiveDownloadRestrictionWithContext") or {}
    item = restrictions.get("itemDownloadRestriction") or {}

    reader_restricted = bool(
        effective.get("restrictedForReaders", item.get("restrictedForReaders", False))
    )
    writer_restricted = bool(
        effective.get("restrictedForWriters", item.get("restrictedForWriters", False))
    )
    return reader_restricted, writer_restricted


def _download_restrictions_match(info: dict, restricted: bool) -> bool:
    return all(value == restricted for value in _download_restriction_values(info))


def copy_restriction_matches(service, file_id: str, *, restricted: bool) -> bool:
    info = execute_with_retry(
        service.files().get(
            fileId=file_id,
            fields=(
                "copyRequiresWriterPermission,"
                "downloadRestrictions(itemDownloadRestriction,"
                "effectiveDownloadRestrictionWithContext)"
            ),
            supportsAllDrives=True,
        )
    )
    return _download_restrictions_match(info, restricted)


def set_copy_restriction(service, file_id: str, *, restricted: bool) -> bool:
    """Set Drive's restriction and verify both reader and writer values."""
    info = execute_with_retry(
        service.files().update(
            fileId=file_id,
            body=_download_restriction_payload(restricted),
            fields=(
                "id,copyRequiresWriterPermission,"
                "downloadRestrictions(itemDownloadRestriction,"
                "effectiveDownloadRestrictionWithContext)"
            ),
            supportsAllDrives=True,
        )
    )
    return _download_restrictions_match(info, restricted)


class OwnerRouter:
    """Pick the right owner token for each file.

    The copy/download restriction can only be set by a file's OWNER. When one
    folder mixes files from several accounts, a single token hits HTTP 403 on
    every file it does not own. This router loads one :class:`ServiceFactory`
    per token, keyed by that token's authenticated Google email, and hands back
    the factory whose account owns a given file. Each factory keeps its own
    per-thread Drive service, so routing stays thread-safe under the worker pool.
    """

    def __init__(self, token_paths: Iterable[str]) -> None:
        self.factories_by_email: dict[str, ServiceFactory] = {}
        self.factories: list[ServiceFactory] = []
        self.emails: list[str] = []
        self.skipped_token_errors: list[str] = []
        # Kept as the default/fallback owner service. Folder discovery itself
        # tries every loaded factory when an earlier token has no access.
        self.scanner: ServiceFactory | None = None
        seen_paths: set[str] = set()
        token_path_list = [str(raw_path).strip() for raw_path in token_paths]

        for path in token_path_list:
            if not path or path in seen_paths:
                continue
            seen_paths.add(path)
            try:
                factory = ServiceFactory(path)
                email = get_authenticated_email(factory.primary)
            except OAuthTokenError as exc:
                self._skip_unusable_token(str(exc))
                continue
            except HttpError as exc:
                self._skip_unusable_token(
                    f"Could not verify OAuth token account: {exc}{_error_hint(exc)} "
                    f"Token: {path}"
                )
                continue
            key = email.casefold()
            if not key:
                self._skip_unusable_token(
                    f"Drive did not return an account email for this token. Token: {path}"
                )
                continue
            if key in self.factories_by_email:
                # Duplicate account (same email behind two token files): keep the
                # first, ignore the rest so we never double-count an owner.
                continue
            self.factories_by_email[key] = factory
            self.factories.append(factory)
            self.emails.append(email)
            if self.scanner is None:
                self.scanner = factory

        if self.scanner is None:
            raise OAuthTokenError(
                next((path for path in token_path_list if path), "token.json"),
                "No usable owner tokens were provided for block/unblock.",
            )

    def _skip_unusable_token(self, reason: str) -> None:
        self.skipped_token_errors.append(reason)
        print(f"[WARN] Skipping unusable restriction token: {reason}", file=sys.stderr)

    def factory_for(self, item: DriveItem) -> ServiceFactory | None:
        """Return the token factory that owns ``item``, or None if unmatched.

        Falls back to the single loaded token when Drive returns no owner
        metadata AND only one account was supplied — the classic one-owner case.
        """
        for email in item.owner_emails:
            factory = self.factories_by_email.get(email.casefold())
            if factory is not None:
                return factory
        if not item.owner_emails and len(self.factories_by_email) == 1:
            return self.scanner
        return None


def run_block(args: argparse.Namespace) -> int:
    workers = max(1, min(getattr(args, "workers", 4), 16))
    token_paths = args.token or ["token.json"]
    try:
        router = OwnerRouter(token_paths)
    except OAuthTokenError as exc:
        print(f"[AUTH ERR] {exc}", file=sys.stderr)
        return 2
    restricted = not args.unblock
    action = "BLOCK" if restricted else "UNBLOCK"

    target = args.target or ("files" if args.unblock else "videos")
    accept_target, target_label = BLOCK_TARGETS[target]
    try:
        targets = collect_files_parallel(
            router.factories,
            args.folder_id,
            recursive=args.recursive,
            max_depth=args.max_depth,
            accept=accept_target,
            workers=workers,
        )
    except HttpError as exc:
        print(f"[ERR]  scan folders: {exc}{_error_hint(exc)}", file=sys.stderr)
        return 1
    if args.max_items is not None:
        targets = targets[: args.max_items]
    print(
        f"Found {len(targets)} {target_label} across {len(args.folder_id)} folder(s). "
        f"target={target} action={action} workers={workers} "
        f"owners={len(router.factories_by_email)} tokens=[{', '.join(router.emails)}] "
        f"skipped_tokens={len(router.skipped_token_errors)} "
        f"dry_run={args.dry_run}"
    )

    def process_one(item: DriveItem) -> ItemOutcome:
        label = f"{item.name} ({item.id})"
        factory = router.factory_for(item)
        if factory is None:
            return ItemOutcome(
                "skip",
                f"[SKIP] {action} {label}: no owner token loaded for "
                f"{describe_item_owners(item)} — add or re-login that account's token",
            )
        if args.dry_run:
            return ItemOutcome("ok", f"[DRY]  {action} {label}")
        service = factory.get()
        try:
            if copy_restriction_matches(service, item.id, restricted=restricted):
                return ItemOutcome(
                    "skip", f"[SKIP] {action} {label}: already {action.lower()}ed"
                )
            applied = set_copy_restriction(service, item.id, restricted=restricted)
            if not applied:
                return ItemOutcome(
                    "fail",
                    f"[ERR]  {label}: Drive did not apply the {action.lower()} flag",
                )
            return ItemOutcome("ok", f"[OK]   {action} {label}")
        except HttpError as exc:
            return ItemOutcome("fail", f"[ERR]  {label}: {exc}{_error_hint(exc)}")

    counts = run_item_batch(
        targets,
        process_one,
        workers=1 if args.dry_run else workers,
        sleep_seconds=args.sleep,
    )

    print(
        f"Done. {action.lower()}ed={counts['ok']}, "
        f"skipped={counts['skip']}, failed={counts['fail']}"
    )
    return 1 if counts["fail"] else 0


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


def _add_common_scan_args(p: argparse.ArgumentParser) -> None:
    p.add_argument(
        "--folder-id",
        action="append",
        required=True,
        metavar="ID",
        help="Subject folder ID (Toán / Lý / Hóa ...). Repeat for multiple folders.",
    )
    p.add_argument(
        "--recursive",
        action="store_true",
        help="Scan sub-folders too (recommended for nested course structures).",
    )
    p.add_argument(
        "--max-items",
        type=int,
        help="Stop after this many matching files (useful for daily quota batching).",
    )
    p.add_argument(
        "--max-depth",
        type=int,
        help=(
            "Maximum recursive folder depth below each root. "
            "0 scans only files directly in each root folder."
        ),
    )
    p.add_argument(
        "--sleep",
        type=float,
        default=0.0,
        help=(
            "Seconds each worker waits after every API call to respect rate "
            "limits (default: 0.0; raise if you hit HTTP 429)."
        ),
    )
    p.add_argument(
        "--workers",
        type=int,
        default=4,
        help="Number of parallel threads (default: 4, max 16).",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="List the matching files that would be changed without changing anything.",
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Transfer video ownership and manage Drive download restrictions.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    t = sub.add_parser("transfer", help="Move video ownership from account A to account B.")
    _add_common_scan_args(t)
    t.add_argument("--to-email", required=True, help="Account B email address.")
    t.add_argument(
        "--owner-token",
        default="token.json",
        help="OAuth token JSON for account A (default: token.json).",
    )
    t.add_argument(
        "--accept-token",
        help="OAuth token JSON for account B. Required to auto-accept consumer transfers.",
    )
    t.add_argument(
        "--credentials",
        default="credentials.json",
        help="OAuth client JSON used when --reauth-accept-token is needed.",
    )
    t.add_argument(
        "--reauth-accept-token",
        action="store_true",
        help=(
            "If --accept-token is expired/revoked, open Chrome/browser login "
            "and overwrite it with a fresh account B token."
        ),
    )
    t.add_argument(
        "--mode",
        choices=("consumer", "workspace"),
        default="consumer",
        help="consumer = pending owner + B accepts; workspace = direct transfer.",
    )
    t.add_argument(
        "--no-notify",
        action="store_true",
        help="Do not send Google email notifications where the API allows it.",
    )
    t.set_defaults(func=run_transfer)

    b = sub.add_parser(
        "block",
        help="Block (or --unblock) Download/Copy/Print for matching files.",
    )
    _add_common_scan_args(b)
    b.add_argument(
        "--token",
        action="append",
        metavar="TOKEN_JSON",
        help=(
            "OAuth token JSON for an account that OWNS some of the matching files. "
            "Repeat --token for every owner whose files live in the folder; "
            "each file is routed to the matching owner's token automatically "
            "(default: token.json when none given)."
        ),
    )
    b.add_argument(
        "--target",
        choices=tuple(BLOCK_TARGETS),
        help=(
            "Target videos, all files, or Google Sheets. Defaults to videos for "
            "block and all files for --unblock."
        ),
    )
    b.add_argument(
        "--unblock",
        action="store_true",
        help="Reverse the restriction (re-allow download/copy/print).",
    )
    b.set_defaults(func=run_block)

    return parser.parse_args()


def main() -> int:
    args = parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
