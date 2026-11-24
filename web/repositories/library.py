from errors import ApiError


def list_folders(conn, uid):
    return conn.execute(
        "SELECT id, name FROM folders WHERE user_id = ? ORDER BY name",
        (uid,),
    ).fetchall()


def create_folder(conn, uid, name):
    cur = conn.execute("INSERT INTO folders (user_id, name) VALUES (?, ?)", (uid, name))
    return cur.lastrowid


def rename_folder(conn, uid, folder_id, name):
    cur = conn.execute(
        "UPDATE folders SET name = ? WHERE id = ? AND user_id = ?",
        (name, folder_id, uid),
    )
    return cur.rowcount


def delete_folder(conn, uid, folder_id):
    row = conn.execute(
        "SELECT id FROM folders WHERE id = ? AND user_id = ?",
        (folder_id, uid),
    ).fetchone()
    if row is None:
        return False
    conn.execute(
        "UPDATE maps SET folder_id = NULL WHERE folder_id = ? AND owner_id = ?",
        (folder_id, uid),
    )
    conn.execute("DELETE FROM folders WHERE id = ? AND user_id = ?", (folder_id, uid))
    return True


def list_tags(conn, uid):
    return conn.execute(
        "SELECT id, name FROM tags WHERE user_id = ? ORDER BY name",
        (uid,),
    ).fetchall()


def create_tag(conn, uid, name):
    cur = conn.execute("INSERT INTO tags (user_id, name) VALUES (?, ?)", (uid, name))
    return cur.lastrowid


def delete_tag(conn, uid, tag_id):
    cur = conn.execute("DELETE FROM tags WHERE id = ? AND user_id = ?", (tag_id, uid))
    return cur.rowcount


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


def list_maps(conn, uid, folder, tag):
    sql = "SELECT * FROM maps WHERE owner_id = ?"
    args = [uid]
    if folder == "root":
        sql += " AND folder_id IS NULL"
    elif folder != "all":
        if not str(folder).isdigit():
            raise ApiError("Некорректная папка")
        sql += " AND folder_id = ?"
        args.append(int(folder))
    if tag:
        if not str(tag).isdigit():
            raise ApiError("Некорректный тег")
        sql += " AND id IN (SELECT map_id FROM map_tags WHERE tag_id = ?)"
        args.append(int(tag))
    sql += " ORDER BY updated_at DESC LIMIT 100"
    return conn.execute(sql, args).fetchall()


def insert_map(conn, uid, folder_id, name, raw, preview, is_public, token, stamp):
    cur = conn.execute(
        """
        INSERT INTO maps
            (owner_id, folder_id, name, data_json, preview, is_public, share_token, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (uid, folder_id, name, raw, preview, int(is_public), token, stamp, stamp),
    )
    return cur.lastrowid


def update_map(conn, map_id, name, folder_id, raw, preview, is_public, stamp):
    conn.execute(
        """
        UPDATE maps
        SET name = ?, folder_id = ?, data_json = ?, preview = ?, is_public = ?, updated_at = ?
        WHERE id = ?
        """,
        (name, folder_id, raw, preview, int(is_public), stamp, map_id),
    )


def get_map(conn, map_id):
    return conn.execute("SELECT * FROM maps WHERE id = ?", (map_id,)).fetchone()


def delete_map(conn, map_id):
    conn.execute("DELETE FROM maps WHERE id = ?", (map_id,))


def copy_tags(conn, copy_id, map_id):
    conn.execute(
        "INSERT INTO map_tags (map_id, tag_id) SELECT ?, tag_id FROM map_tags WHERE map_id = ?",
        (copy_id, map_id),
    )


def set_public(conn, map_id, is_public, stamp):
    conn.execute(
        "UPDATE maps SET is_public = ?, updated_at = ? WHERE id = ?",
        (int(is_public), stamp, map_id),
    )
