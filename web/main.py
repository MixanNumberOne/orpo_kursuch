import json
import os
import re
import secrets
import sqlite3
import uuid
from datetime import timedelta
from functools import wraps
from pathlib import Path

from flask import Flask, abort, jsonify, render_template, request, send_file, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash

from db import data_dir, db, init_db, now, secret_key

BASE_DIR = Path(__file__).resolve().parent
JS_DIR = BASE_DIR / "js"
MAX_ASSET = int(os.environ.get("DUNGEON_MAX_ASSET", str(int(1.5 * 1024 * 1024))))
MAX_DOCUMENT = 5_000_000
USER_RE = re.compile(r"^[A-Za-zА-Яа-яЁё0-9_\-]{3,32}$")
UNSAFE = {"POST", "PUT", "PATCH", "DELETE"}

app = Flask(
    __name__,
    template_folder=str(BASE_DIR / "templates"),
    static_folder=str(BASE_DIR / "static"),
    static_url_path="/static",
)
app.json.ensure_ascii = False
app.config.update(
    SECRET_KEY=secret_key(),
    MAX_CONTENT_LENGTH=8 * 1024 * 1024,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(days=14),
    TEMPLATES_AUTO_RELOAD=True,
)


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


def require_csrf():
    expected = session.get("csrf") or ""
    got = request.headers.get("X-CSRF-Token", "")
    if not expected or len(got) != len(expected) or not secrets.compare_digest(got, expected):
        raise ApiError("Недействительный CSRF-токен", 403)


def auth_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if request.method in UNSAFE:
            require_csrf()
        uid = session.get("user_id")
        if not uid:
            raise ApiError("Требуется авторизация", 401)
        with db() as conn:
            row = conn.execute("SELECT id FROM users WHERE id = ?", (uid,)).fetchone()
        if row is None:
            session.pop("user_id", None)
            raise ApiError("Требуется авторизация", 401)
        return fn(*args, **kwargs)

    return wrapper


@app.before_request
def ensure_csrf():
    if "csrf" not in session:
        session["csrf"] = secrets.token_hex(16)


@app.after_request
def disable_asset_cache(response):
    if request.path.startswith("/js/") or request.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.errorhandler(ApiError)
def handle_api_error(err):
    return jsonify(error=err.message), err.status


@app.errorhandler(413)
def handle_too_large(_err):
    return jsonify(error="Файл больше допустимого размера"), 413


@app.errorhandler(404)
def handle_404(err):
    if request.path.startswith("/api/"):
        return jsonify(error="Не найдено"), 404
    return err


def body():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ApiError("Ожидался JSON-объект")
    return data


def clean_username(value):
    if not isinstance(value, str) or not USER_RE.fullmatch(value.strip()):
        raise ApiError("Имя: 3–32 символа, буквы, цифры, _ и -")
    return value.strip()


def clean_password(value):
    if not isinstance(value, str) or not (4 <= len(value) <= 128):
        raise ApiError("Пароль должен быть от 4 до 128 символов")
    return value


def clean_title(value, default="Новая карта", limit=80):
    if value is None:
        return default
    if not isinstance(value, str):
        raise ApiError("Некорректное название")
    name = value.strip() or default
    if len(name) > limit:
        raise ApiError("Слишком длинное название")
    return name


def required_name(value, limit=40):
    if not isinstance(value, str) or not value.strip():
        raise ApiError("Введите название")
    name = value.strip()
    if len(name) > limit:
        raise ApiError("Слишком длинное название")
    return name


def as_bool(value):
    if isinstance(value, bool):
        return value
    if value in (0, 1):
        return bool(value)
    raise ApiError("Некорректный признак публикации")


def clean_comment(value):
    if not isinstance(value, str):
        raise ApiError("Введите комментарий")
    text = value.strip()
    if not text:
        raise ApiError("Введите комментарий")
    if len(text) > 1000:
        raise ApiError("Комментарий длиннее 1000 символов")
    return text


def clean_preview(value):
    if not isinstance(value, str):
        return ""
    if not value.startswith("data:image/") or len(value) > 200_000:
        return ""
    return value


def validate_doc(data):
    if not isinstance(data, dict):
        return "Некорректный документ"
    cols, rows = data.get("cols"), data.get("rows")
    if isinstance(cols, bool) or isinstance(rows, bool) or not isinstance(cols, int) or not isinstance(rows, int):
        return "Некорректный размер карты"
    if not (8 <= cols <= 96 and 8 <= rows <= 64):
        return "Некорректный размер карты"
    layers = data.get("layers")
    if not isinstance(layers, list) or not (1 <= len(layers) <= 24):
        return "Нужен хотя бы один слой"
    need = cols * rows
    tiles_found = False
    for layer in layers:
        if not isinstance(layer, dict):
            return "Некорректный слой"
        kind = layer.get("kind")
        if kind == "tiles":
            tiles_found = True
            tiles = layer.get("tiles")
            if not isinstance(tiles, list) or len(tiles) != need:
                return "Слой тайлов не совпадает с размером карты"
            for tile in tiles:
                if isinstance(tile, bool) or not isinstance(tile, int) or not (0 <= tile <= 9):
                    return "Некорректная клетка карты"
        elif kind in ("objects", "notes"):
            items = layer.get("items", [])
            if not isinstance(items, list) or len(items) > 400:
                return "Слишком много объектов на слое"
        else:
            return "Неизвестный тип слоя"
    if not tiles_found:
        return "Нужен слой тайлов"
    history = data.get("history")
    if history is not None:
        if not isinstance(history, dict):
            return "Некорректная история"
        for key in ("undo", "redo"):
            stack = history.get(key) or []
            if not isinstance(stack, list):
                return "Некорректная история"
            if len(stack) > 40:
                history[key] = stack[-40:]
    return None


def document_json(data):
    error = validate_doc(data)
    if error:
        raise ApiError(error)
    raw = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    if len(raw) > MAX_DOCUMENT:
        raise ApiError("Карта слишком большая")
    return raw


def sanitize_public(data):
    layers = []
    for layer in data.get("layers") or []:
        if not isinstance(layer, dict) or layer.get("kind") == "notes" or layer.get("visible") is False:
            continue
        public = {
            "id": layer.get("id"),
            "name": layer.get("name"),
            "kind": layer.get("kind"),
            "visible": True,
            "locked": True,
        }
        if layer.get("kind") == "tiles":
            public["tiles"] = layer.get("tiles") or []
        else:
            items = []
            for item in layer.get("items") or []:
                if isinstance(item, dict):
                    items.append({
                        "id": item.get("id"),
                        "kind": item.get("kind"),
                        "x": item.get("x"),
                        "y": item.get("y"),
                        "w": item.get("w"),
                        "h": item.get("h"),
                        "src": item.get("src") or "",
                        "text": item.get("text") or "",
                        "description": item.get("description") or "",
                        "color": item.get("color") or "#f3e6c0",
                        "name": item.get("name") or "",
                    })
            public["items"] = items
        layers.append(public)
    grid = data.get("grid") if isinstance(data.get("grid"), dict) else {}
    return {"cols": data.get("cols"), "rows": data.get("rows"), "grid": grid, "layers": layers}


def tags_by_map(conn, map_ids):
    grouped = {mid: [] for mid in map_ids}
    if not map_ids:
        return grouped
    marks = ",".join("?" * len(map_ids))
    rows = conn.execute(
        f"""
        SELECT mt.map_id, t.id, t.name
        FROM map_tags mt JOIN tags t ON t.id = mt.tag_id
        WHERE mt.map_id IN ({marks})
        ORDER BY t.name
        """,
        map_ids,
    ).fetchall()
    for row in rows:
        grouped[row["map_id"]].append({"id": row["id"], "name": row["name"]})
    return grouped


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


def owned_map(conn, mid, uid):
    row = conn.execute("SELECT * FROM maps WHERE id = ? AND owner_id = ?", (mid, uid)).fetchone()
    if row is None:
        raise ApiError("Карта не найдена", 404)
    return row


def resolve_folder(conn, uid, folder_id):
    if folder_id in (None, ""):
        return None
    if isinstance(folder_id, bool) or not isinstance(folder_id, int):
        raise ApiError("Некорректная папка")
    row = conn.execute("SELECT id FROM folders WHERE id = ? AND user_id = ?", (folder_id, uid)).fetchone()
    if row is None:
        raise ApiError("Папка не найдена", 404)
    return folder_id


def set_tags(conn, map_id, uid, tag_ids):
    if tag_ids is None:
        return
    if not isinstance(tag_ids, list) or len(tag_ids) > 20:
        raise ApiError("Некорректный список тегов")
    clean = []
    for tag_id in tag_ids:
        if isinstance(tag_id, bool) or not isinstance(tag_id, int):
            raise ApiError("Некорректный тег")
        clean.append(tag_id)
    unique = list(dict.fromkeys(clean))
    if unique:
        marks = ",".join("?" * len(unique))
        rows = conn.execute(
            f"SELECT id FROM tags WHERE user_id = ? AND id IN ({marks})",
            [uid, *unique],
        ).fetchall()
        if len(rows) != len(unique):
            raise ApiError("Тег не найден", 404)
    conn.execute("DELETE FROM map_tags WHERE map_id = ?", (map_id,))
    for tag_id in unique:
        conn.execute("INSERT INTO map_tags (map_id, tag_id) VALUES (?, ?)", (map_id, tag_id))


def comments_for(conn, map_id, uid):
    rows = conn.execute(
        """
        SELECT c.id, c.text, c.created_at, c.author_id, u.username AS author
        FROM comments c JOIN users u ON u.id = c.author_id
        WHERE c.map_id = ?
        ORDER BY c.created_at ASC
        """,
        (map_id,),
    ).fetchall()
    return [
        {
            "id": row["id"],
            "text": row["text"],
            "created_at": row["created_at"],
            "author": row["author"],
            "mine": uid is not None and row["author_id"] == uid,
        }
        for row in rows
    ]


def save_fields(data, current=None):
    name = clean_title(data.get("name"), default=current["name"] if current else "Новая карта")
    if "is_public" in data:
        is_public = as_bool(data.get("is_public"))
    else:
        is_public = bool(current["is_public"]) if current else False
    if "data" not in data:
        raise ApiError("Нет данных карты")
    raw = document_json(data.get("data"))
    preview = clean_preview(data.get("preview", ""))
    return name, is_public, raw, preview


@app.get("/")
def index():
    return render_template("index.html", csrf=session.get("csrf", ""))


@app.get("/s/<token>")
def shared_page(token):
    if not re.fullmatch(r"[A-Za-z0-9_\-]{8,80}", token):
        abort(404)
    return render_template("view.html", token=token)


@app.get("/js/<path:filename>")
def scripts(filename):
    return send_from_directory(JS_DIR, filename)


@app.get("/favicon.ico")
def favicon():
    return ("", 204)


@app.get("/api/auth/me")
def me():
    uid = session.get("user_id")
    if not uid:
        return jsonify(user=None)
    with db() as conn:
        row = conn.execute("SELECT id, username FROM users WHERE id = ?", (uid,)).fetchone()
    if row is None:
        session.pop("user_id", None)
        return jsonify(user=None)
    return jsonify(user={"id": row["id"], "username": row["username"]})


@app.post("/api/auth/register")
def register():
    require_csrf()
    data = body()
    username = clean_username(data.get("username"))
    password = clean_password(data.get("password"))
    try:
        with db() as conn:
            cur = conn.execute(
                "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
                (username, generate_password_hash(password), now()),
            )
            uid = cur.lastrowid
    except sqlite3.IntegrityError:
        raise ApiError("Такое имя уже занято", 409) from None
    session["user_id"] = uid
    session.permanent = True
    return jsonify(user={"id": uid, "username": username}), 201


@app.post("/api/auth/login")
def login():
    require_csrf()
    data = body()
    username = data.get("username")
    password = data.get("password")
    if not isinstance(username, str) or not isinstance(password, str):
        raise ApiError("Неверное имя или пароль", 401)
    with db() as conn:
        row = conn.execute("SELECT * FROM users WHERE username = ?", (username.strip(),)).fetchone()
    if row is None or not check_password_hash(row["password_hash"], password):
        raise ApiError("Неверное имя или пароль", 401)
    session["user_id"] = row["id"]
    session.permanent = True
    return jsonify(user={"id": row["id"], "username": row["username"]})


@app.post("/api/auth/logout")
def logout():
    require_csrf()
    session.pop("user_id", None)
    return jsonify(ok=True)


@app.get("/api/folders")
@auth_required
def list_folders():
    with db() as conn:
        rows = conn.execute(
            "SELECT id, name FROM folders WHERE user_id = ? ORDER BY name",
            (session["user_id"],),
        ).fetchall()
    return jsonify(items=[{"id": row["id"], "name": row["name"]} for row in rows])


@app.post("/api/folders")
@auth_required
def create_folder():
    name = required_name(body().get("name"))
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO folders (user_id, name) VALUES (?, ?)",
            (session["user_id"], name),
        )
        folder_id = cur.lastrowid
    return jsonify(id=folder_id, name=name), 201


@app.put("/api/folders/<int:folder_id>")
@auth_required
def rename_folder(folder_id):
    name = required_name(body().get("name"))
    with db() as conn:
        cur = conn.execute(
            "UPDATE folders SET name = ? WHERE id = ? AND user_id = ?",
            (name, folder_id, session["user_id"]),
        )
        if cur.rowcount == 0:
            raise ApiError("Папка не найдена", 404)
    return jsonify(id=folder_id, name=name)


@app.delete("/api/folders/<int:folder_id>")
@auth_required
def delete_folder(folder_id):
    uid = session["user_id"]
    with db() as conn:
        row = conn.execute(
            "SELECT id FROM folders WHERE id = ? AND user_id = ?",
            (folder_id, uid),
        ).fetchone()
        if row is None:
            raise ApiError("Папка не найдена", 404)
        conn.execute(
            "UPDATE maps SET folder_id = NULL WHERE folder_id = ? AND owner_id = ?",
            (folder_id, uid),
        )
        conn.execute("DELETE FROM folders WHERE id = ? AND user_id = ?", (folder_id, uid))
    return jsonify(ok=True)


@app.get("/api/tags")
@auth_required
def list_tags():
    with db() as conn:
        rows = conn.execute(
            "SELECT id, name FROM tags WHERE user_id = ? ORDER BY name",
            (session["user_id"],),
        ).fetchall()
    return jsonify(items=[{"id": row["id"], "name": row["name"]} for row in rows])


@app.post("/api/tags")
@auth_required
def create_tag():
    name = required_name(body().get("name"), limit=24)
    try:
        with db() as conn:
            cur = conn.execute(
                "INSERT INTO tags (user_id, name) VALUES (?, ?)",
                (session["user_id"], name),
            )
            tag_id = cur.lastrowid
    except sqlite3.IntegrityError:
        raise ApiError("Такой тег уже есть", 409) from None
    return jsonify(id=tag_id, name=name), 201


@app.delete("/api/tags/<int:tag_id>")
@auth_required
def delete_tag(tag_id):
    with db() as conn:
        cur = conn.execute(
            "DELETE FROM tags WHERE id = ? AND user_id = ?",
            (tag_id, session["user_id"]),
        )
        if cur.rowcount == 0:
            raise ApiError("Тег не найден", 404)
    return jsonify(ok=True)


@app.get("/api/maps")
@auth_required
def list_maps():
    folder = request.args.get("folder", "all")
    tag = request.args.get("tag")
    sql = "SELECT * FROM maps WHERE owner_id = ?"
    args = [session["user_id"]]
    if folder == "root":
        sql += " AND folder_id IS NULL"
    elif folder != "all":
        if not folder.isdigit():
            raise ApiError("Некорректная папка")
        sql += " AND folder_id = ?"
        args.append(int(folder))
    if tag:
        if not str(tag).isdigit():
            raise ApiError("Некорректный тег")
        sql += " AND id IN (SELECT map_id FROM map_tags WHERE tag_id = ?)"
        args.append(int(tag))
    sql += " ORDER BY updated_at DESC LIMIT 100"
    with db() as conn:
        rows = conn.execute(sql, args).fetchall()
        grouped = tags_by_map(conn, [row["id"] for row in rows])
    return jsonify(items=[map_payload(row, grouped[row["id"]]) for row in rows])


@app.post("/api/maps")
@auth_required
def create_map():
    data = body()
    uid = session["user_id"]
    name, is_public, raw, preview = save_fields(data)
    stamp = now()
    token = secrets.token_urlsafe(18)
    with db() as conn:
        folder_id = resolve_folder(conn, uid, data.get("folder_id"))
        cur = conn.execute(
            """
            INSERT INTO maps
                (owner_id, folder_id, name, data_json, preview, is_public, share_token, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (uid, folder_id, name, raw, preview, int(is_public), token, stamp, stamp),
        )
        map_id = cur.lastrowid
        set_tags(conn, map_id, uid, data.get("tag_ids") or [])
        row = conn.execute("SELECT * FROM maps WHERE id = ?", (map_id,)).fetchone()
        tags = tags_by_map(conn, [map_id])[map_id]
    return jsonify(map_payload(row, tags)), 201


@app.get("/api/maps/<int:map_id>")
@auth_required
def get_map(map_id):
    with db() as conn:
        row = owned_map(conn, map_id, session["user_id"])
        tags = tags_by_map(conn, [map_id])[map_id]
    return jsonify(map_payload(row, tags, include_data=True))


@app.put("/api/maps/<int:map_id>")
@auth_required
def update_map(map_id):
    data = body()
    uid = session["user_id"]
    with db() as conn:
        row = owned_map(conn, map_id, uid)
        name, is_public, raw, preview = save_fields(data, row)
        folder_id = resolve_folder(conn, uid, data.get("folder_id")) if "folder_id" in data else row["folder_id"]
        conn.execute(
            """
            UPDATE maps
            SET name = ?, folder_id = ?, data_json = ?, preview = ?, is_public = ?, updated_at = ?
            WHERE id = ?
            """,
            (name, folder_id, raw, preview, int(is_public), now(), map_id),
        )
        if "tag_ids" in data:
            set_tags(conn, map_id, uid, data.get("tag_ids") or [])
        saved = conn.execute("SELECT * FROM maps WHERE id = ?", (map_id,)).fetchone()
        tags = tags_by_map(conn, [map_id])[map_id]
    return jsonify(map_payload(saved, tags))


@app.delete("/api/maps/<int:map_id>")
@auth_required
def delete_map(map_id):
    with db() as conn:
        owned_map(conn, map_id, session["user_id"])
        conn.execute("DELETE FROM maps WHERE id = ?", (map_id,))
    return jsonify(ok=True)


@app.post("/api/maps/<int:map_id>/duplicate")
@auth_required
def duplicate_map(map_id):
    uid = session["user_id"]
    stamp = now()
    with db() as conn:
        row = owned_map(conn, map_id, uid)
        copy_name = f"Копия {row['name']}"[:80]
        cur = conn.execute(
            """
            INSERT INTO maps
                (owner_id, folder_id, name, data_json, preview, is_public, share_token, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
            """,
            (uid, row["folder_id"], copy_name, row["data_json"], row["preview"], secrets.token_urlsafe(18), stamp, stamp),
        )
        copy_id = cur.lastrowid
        conn.execute(
            "INSERT INTO map_tags (map_id, tag_id) SELECT ?, tag_id FROM map_tags WHERE map_id = ?",
            (copy_id, map_id),
        )
        saved = conn.execute("SELECT * FROM maps WHERE id = ?", (copy_id,)).fetchone()
        tags = tags_by_map(conn, [copy_id])[copy_id]
    return jsonify(map_payload(saved, tags)), 201


@app.post("/api/maps/<int:map_id>/share")
@auth_required
def set_share(map_id):
    is_public = as_bool(body().get("is_public"))
    with db() as conn:
        row = owned_map(conn, map_id, session["user_id"])
        conn.execute(
            "UPDATE maps SET is_public = ?, updated_at = ? WHERE id = ?",
            (int(is_public), now(), map_id),
        )
    return jsonify(is_public=is_public, share_token=row["share_token"])


@app.get("/api/assets")
@auth_required
def list_assets():
    with db() as conn:
        rows = conn.execute(
            "SELECT id, name, mime, created_at FROM assets WHERE user_id = ? ORDER BY created_at DESC",
            (session["user_id"],),
        ).fetchall()
    return jsonify(items=[dict(row) for row in rows])


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


@app.post("/api/assets")
@auth_required
def upload_asset():
    upload = request.files.get("file")
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
    relative = Path("uploads") / str(session["user_id"]) / f"{asset_id}{ext}"
    full = data_dir() / relative
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_bytes(blob)
    stamp = now()
    with db() as conn:
        conn.execute(
            "INSERT INTO assets (id, user_id, name, mime, path, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (asset_id, session["user_id"], name, mime, relative.as_posix(), stamp),
        )
    return jsonify(asset={"id": asset_id, "name": name, "mime": mime, "created_at": stamp}), 201


@app.get("/api/assets/<asset_id>/file")
@auth_required
def asset_file(asset_id):
    if not re.fullmatch(r"[a-f0-9]{32}", asset_id):
        raise ApiError("Файл не найден", 404)
    with db() as conn:
        row = conn.execute(
            "SELECT path, mime FROM assets WHERE id = ? AND user_id = ?",
            (asset_id, session["user_id"]),
        ).fetchone()
    if row is None:
        raise ApiError("Файл не найден", 404)
    return send_file(safe_upload(row["path"]), mimetype=row["mime"], max_age=3600)


@app.delete("/api/assets/<asset_id>")
@auth_required
def delete_asset(asset_id):
    if not re.fullmatch(r"[a-f0-9]{32}", asset_id):
        raise ApiError("Файл не найден", 404)
    with db() as conn:
        row = conn.execute(
            "SELECT path FROM assets WHERE id = ? AND user_id = ?",
            (asset_id, session["user_id"]),
        ).fetchone()
        if row is None:
            raise ApiError("Файл не найден", 404)
        conn.execute("DELETE FROM assets WHERE id = ?", (asset_id,))
    try:
        safe_upload(row["path"]).unlink()
    except ApiError:
        pass
    return jsonify(ok=True)


@app.get("/api/gallery")
def gallery():
    order = "m.updated_at ASC" if request.args.get("sort") == "old" else "m.updated_at DESC"
    with db() as conn:
        rows = conn.execute(
            f"""
            SELECT m.id, m.name, m.preview, m.updated_at, u.username AS author,
                   (SELECT COUNT(*) FROM comments c WHERE c.map_id = m.id) AS comment_count
            FROM maps m JOIN users u ON u.id = m.owner_id
            WHERE m.is_public = 1
            ORDER BY {order}
            LIMIT 100
            """
        ).fetchall()
    return jsonify(items=[dict(row) for row in rows])


@app.get("/api/gallery/<int:map_id>")
def gallery_map(map_id):
    uid = session.get("user_id")
    with db() as conn:
        row = conn.execute(
            """
            SELECT m.*, u.username AS author
            FROM maps m JOIN users u ON u.id = m.owner_id
            WHERE m.id = ? AND m.is_public = 1
            """,
            (map_id,),
        ).fetchone()
        if row is None:
            raise ApiError("Карта не найдена", 404)
        comments = comments_for(conn, map_id, uid)
    return jsonify(
        id=row["id"],
        name=row["name"],
        author=row["author"],
        updated_at=row["updated_at"],
        data=sanitize_public(json.loads(row["data_json"])),
        comments=comments,
    )


@app.post("/api/gallery/<int:map_id>/comments")
@auth_required
def add_comment(map_id):
    text = clean_comment(body().get("text"))
    uid = session["user_id"]
    stamp = now()
    with db() as conn:
        row = conn.execute("SELECT is_public FROM maps WHERE id = ?", (map_id,)).fetchone()
        if row is None or not row["is_public"]:
            raise ApiError("Комментировать можно только публичные карты", 404)
        cur = conn.execute(
            "INSERT INTO comments (map_id, author_id, text, created_at) VALUES (?, ?, ?, ?)",
            (map_id, uid, text, stamp),
        )
        comment_id = cur.lastrowid
        author = conn.execute("SELECT username FROM users WHERE id = ?", (uid,)).fetchone()["username"]
    return jsonify(id=comment_id, text=text, created_at=stamp, author=author, mine=True), 201


@app.delete("/api/comments/<int:comment_id>")
@auth_required
def delete_comment(comment_id):
    with db() as conn:
        row = conn.execute("SELECT author_id FROM comments WHERE id = ?", (comment_id,)).fetchone()
        if row is None or row["author_id"] != session["user_id"]:
            raise ApiError("Комментарий не найден", 404)
        conn.execute("DELETE FROM comments WHERE id = ?", (comment_id,))
    return jsonify(ok=True)


@app.get("/api/share/<token>")
def shared_map(token):
    with db() as conn:
        row = conn.execute(
            """
            SELECT m.name, m.is_public, m.updated_at, m.data_json, u.username AS author
            FROM maps m JOIN users u ON u.id = m.owner_id
            WHERE m.share_token = ?
            """,
            (token,),
        ).fetchone()
    if row is None or not row["is_public"]:
        raise ApiError("Доступ к карте закрыт", 403)
    return jsonify(
        name=row["name"],
        author=row["author"],
        updated_at=row["updated_at"],
        data=sanitize_public(json.loads(row["data_json"])),
    )


@app.get("/api/notifications")
@auth_required
def notifications():
    with db() as conn:
        rows = conn.execute(
            """
            SELECT c.id, c.text, c.created_at, c.map_id, m.name AS map_name, u.username AS author
            FROM comments c
            JOIN maps m ON m.id = c.map_id
            JOIN users u ON u.id = c.author_id
            WHERE m.owner_id = ?
            ORDER BY c.created_at DESC
            LIMIT 20
            """,
            (session["user_id"],),
        ).fetchall()
    return jsonify(items=[dict(row) for row in rows])


init_db()

if __name__ == "__main__":
    print("Сервер запущен: http://127.0.0.1:5000")
    app.run(debug=True, host="127.0.0.1", port=5000)
