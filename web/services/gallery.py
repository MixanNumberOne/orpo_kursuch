import json

from db import db, now
from errors import ApiError
from repositories import social
from validation import clean_comment, sanitize_public


def list_gallery(oldest):
    with db() as conn:
        rows = social.list_gallery(conn, oldest)
    return [dict(row) for row in rows]


def gallery_map(map_id, uid):
    with db() as conn:
        row = social.public_map(conn, map_id)
        if row is None:
            raise ApiError("Карта не найдена", 404)
        comments = social.comments_for(conn, map_id, uid)
    return {
        "id": row["id"],
        "name": row["name"],
        "author": row["author"],
        "updated_at": row["updated_at"],
        "data": sanitize_public(json.loads(row["data_json"])),
        "comments": comments,
    }


def add_comment(map_id, uid, text):
    text = clean_comment(text)
    stamp = now()
    with db() as conn:
        row = social.map_visibility(conn, map_id)
        if row is None or not row["is_public"]:
            raise ApiError("Комментировать можно только публичные карты", 404)
        comment_id, author = social.add_comment(conn, map_id, uid, text, stamp)
    return {"id": comment_id, "text": text, "created_at": stamp, "author": author, "mine": True}


def delete_comment(comment_id, uid):
    with db() as conn:
        row = social.comment_author(conn, comment_id)
        if row is None or row["author_id"] != uid:
            raise ApiError("Комментарий не найден", 404)
        social.delete_comment(conn, comment_id)


def shared_map(token):
    with db() as conn:
        row = social.shared_map(conn, token)
    if row is None or not row["is_public"]:
        raise ApiError("Доступ к карте закрыт", 403)
    return {
        "name": row["name"],
        "author": row["author"],
        "updated_at": row["updated_at"],
        "data": sanitize_public(json.loads(row["data_json"])),
    }


def notifications(uid):
    with db() as conn:
        rows = social.notifications(conn, uid)
    return [dict(row) for row in rows]
