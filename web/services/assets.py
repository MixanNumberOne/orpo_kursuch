import re
import uuid
from pathlib import Path

from db import data_dir, db, now
from errors import ApiError
from repositories import assets as repo
from config import MAX_ASSET


def sniff_image(blob):
    if blob.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if blob.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    return None


def safe_upload(relative):
    root = data_dir().resolve()
    full = (root / relative).resolve()
    if root != full and root not in full.parents:
        raise ApiError("Файл не найден", 404)
    if not full.is_file():
        raise ApiError("Файл не найден", 404)
    return full


def list_assets(uid):
    with db() as conn:
        rows = repo.list_assets(conn, uid)
    return [dict(row) for row in rows]


def upload(uid, upload):
    if upload is None or not upload.filename:
        raise ApiError("Выберите файл")
    blob = upload.read(MAX_ASSET + 1)
    if len(blob) > MAX_ASSET:
        raise ApiError("Файл больше допустимого размера")
    mime = sniff_image(blob)
    if mime is None:
        raise ApiError("Допустимы только PNG и JPG")
    raw_name = Path(upload.filename).name
    name = re.sub(r"[^\w.\- ()\u0400-\u04FF]+", "_", raw_name).strip("._")[:80] or "asset"
    asset_id = uuid.uuid4().hex
    ext = ".png" if mime == "image/png" else ".jpg"
    relative = Path("uploads") / str(uid) / f"{asset_id}{ext}"
    full = data_dir() / relative
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_bytes(blob)
    stamp = now()
    with db() as conn:
        repo.insert_asset(conn, asset_id, uid, name, mime, relative.as_posix(), stamp)
    return {"id": asset_id, "name": name, "mime": mime, "created_at": stamp}


def file_for(uid, asset_id):
    if not re.fullmatch(r"[a-f0-9]{32}", asset_id):
        raise ApiError("Файл не найден", 404)
    with db() as conn:
        row = repo.find_asset(conn, asset_id, uid)
    if row is None:
        raise ApiError("Файл не найден", 404)
    return safe_upload(row["path"]), row["mime"]


def delete(uid, asset_id):
    if not re.fullmatch(r"[a-f0-9]{32}", asset_id):
        raise ApiError("Файл не найден", 404)
    with db() as conn:
        row = repo.find_path(conn, asset_id, uid)
        if row is None:
            raise ApiError("Файл не найден", 404)
        repo.delete_asset(conn, asset_id)
    try:
        safe_upload(row["path"]).unlink()
    except ApiError:
        pass
