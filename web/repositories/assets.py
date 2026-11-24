def list_assets(conn, uid):
    return conn.execute(
        "SELECT id, name, mime, created_at FROM assets WHERE user_id = ? ORDER BY created_at DESC",
        (uid,),
    ).fetchall()


def insert_asset(conn, asset_id, uid, name, mime, path, stamp):
    conn.execute(
        "INSERT INTO assets (id, user_id, name, mime, path, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        (asset_id, uid, name, mime, path, stamp),
    )


def find_asset(conn, asset_id, uid):
    return conn.execute(
        "SELECT path, mime FROM assets WHERE id = ? AND user_id = ?",
        (asset_id, uid),
    ).fetchone()


def find_path(conn, asset_id, uid):
    return conn.execute(
        "SELECT path FROM assets WHERE id = ? AND user_id = ?",
        (asset_id, uid),
    ).fetchone()


def delete_asset(conn, asset_id):
    conn.execute("DELETE FROM assets WHERE id = ?", (asset_id,))
