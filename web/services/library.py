import json
import secrets

from db import db, now
from errors import ApiError
from repositories import library as repo
from validation import required_name, save_fields


def map_payload(row, tags, include_data=False):
    payload = {
        "id": row["id"],
        "name": row["name"],
        "folder_id": row["folder_id"],
        "preview": row["preview"] or "",
        "is_public": bool(row["is_public"]),
        "share_token": row["share_token"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "tags": tags,
    }
    if include_data:
        payload["data"] = json.loads(row["data_json"])
    return payload


def list_folders(uid):
    with db() as conn:
        rows = repo.list_folders(conn, uid)
    return [{"id": row["id"], "name": row["name"]} for row in rows]


def create_folder(uid, name):
    name = required_name(name)
    with db() as conn:
        folder_id = repo.create_folder(conn, uid, name)
    return folder_id, name


def rename_folder(uid, folder_id, name):
    name = required_name(name)
    with db() as conn:
        if repo.rename_folder(conn, uid, folder_id, name) == 0:
            raise ApiError("Папка не найдена", 404)
    return name


def delete_folder(uid, folder_id):
    with db() as conn:
        if not repo.delete_folder(conn, uid, folder_id):
            raise ApiError("Папка не найдена", 404)


def list_tags(uid):
    with db() as conn:
        rows = repo.list_tags(conn, uid)
    return [{"id": row["id"], "name": row["name"]} for row in rows]


def create_tag(uid, name):
    import sqlite3
    name = required_name(name, limit=24)
    try:
        with db() as conn:
            tag_id = repo.create_tag(conn, uid, name)
    except sqlite3.IntegrityError:
        raise ApiError("Такой тег уже есть", 409) from None
    return tag_id, name


def delete_tag(uid, tag_id):
    with db() as conn:
        if repo.delete_tag(conn, uid, tag_id) == 0:
            raise ApiError("Тег не найден", 404)


def list_maps(uid, folder, tag):
    with db() as conn:
        rows = repo.list_maps(conn, uid, folder, tag)
        grouped = repo.tags_by_map(conn, [row["id"] for row in rows])
    return [map_payload(row, grouped[row["id"]]) for row in rows]


def create_map(uid, data):
    name, is_public, raw, preview = save_fields(data)
    stamp = now()
    token = secrets.token_urlsafe(18)
    with db() as conn:
        folder_id = repo.resolve_folder(conn, uid, data.get("folder_id"))
        map_id = repo.insert_map(conn, uid, folder_id, name, raw, preview, is_public, token, stamp)
        repo.set_tags(conn, map_id, uid, data.get("tag_ids") or [])
        row = repo.get_map(conn, map_id)
        tags = repo.tags_by_map(conn, [map_id])[map_id]
    return map_payload(row, tags)


def get_map(uid, map_id):
    with db() as conn:
        row = repo.owned_map(conn, map_id, uid)
        tags = repo.tags_by_map(conn, [map_id])[map_id]
    return map_payload(row, tags, include_data=True)


def update_map(uid, map_id, data):
    with db() as conn:
        row = repo.owned_map(conn, map_id, uid)
        name, is_public, raw, preview = save_fields(data, row)
        folder_id = repo.resolve_folder(conn, uid, data.get("folder_id")) if "folder_id" in data else row["folder_id"]
        repo.update_map(conn, map_id, name, folder_id, raw, preview, is_public, now())
        if "tag_ids" in data:
            repo.set_tags(conn, map_id, uid, data.get("tag_ids") or [])
        saved = repo.get_map(conn, map_id)
        tags = repo.tags_by_map(conn, [map_id])[map_id]
    return map_payload(saved, tags)


def delete_map(uid, map_id):
    with db() as conn:
        repo.owned_map(conn, map_id, uid)
        repo.delete_map(conn, map_id)


def duplicate_map(uid, map_id):
    stamp = now()
    with db() as conn:
        row = repo.owned_map(conn, map_id, uid)
        copy_name = f"Копия {row['name']}"[:80]
        copy_id = repo.insert_map(
            conn, uid, row["folder_id"], copy_name, row["data_json"], row["preview"],
            False, secrets.token_urlsafe(18), stamp,
        )
        repo.copy_tags(conn, copy_id, map_id)
        saved = repo.get_map(conn, copy_id)
        tags = repo.tags_by_map(conn, [copy_id])[copy_id]
    return map_payload(saved, tags)


def set_share(uid, map_id, is_public):
    with db() as conn:
        row = repo.owned_map(conn, map_id, uid)
        repo.set_public(conn, map_id, is_public, now())
    return {"is_public": is_public, "share_token": row["share_token"]}
