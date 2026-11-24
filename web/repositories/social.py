def list_gallery(conn, oldest):
    order = "m.updated_at ASC" if oldest else "m.updated_at DESC"
    return conn.execute(
        f"""
        SELECT m.id, m.name, m.preview, m.updated_at, u.username AS author,
               (SELECT COUNT(*) FROM comments c WHERE c.map_id = m.id) AS comment_count
        FROM maps m JOIN users u ON u.id = m.owner_id
        WHERE m.is_public = 1
        ORDER BY {order}
        LIMIT 100
        """
    ).fetchall()


def public_map(conn, map_id):
    return conn.execute(
        """
        SELECT m.*, u.username AS author
        FROM maps m JOIN users u ON u.id = m.owner_id
        WHERE m.id = ? AND m.is_public = 1
        """,
        (map_id,),
    ).fetchone()


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


def map_visibility(conn, map_id):
    return conn.execute("SELECT is_public FROM maps WHERE id = ?", (map_id,)).fetchone()


def add_comment(conn, map_id, uid, text, stamp):
    cur = conn.execute(
        "INSERT INTO comments (map_id, author_id, text, created_at) VALUES (?, ?, ?, ?)",
        (map_id, uid, text, stamp),
    )
    author = conn.execute("SELECT username FROM users WHERE id = ?", (uid,)).fetchone()["username"]
    return cur.lastrowid, author


def comment_author(conn, comment_id):
    return conn.execute("SELECT author_id FROM comments WHERE id = ?", (comment_id,)).fetchone()


def delete_comment(conn, comment_id):
    conn.execute("DELETE FROM comments WHERE id = ?", (comment_id,))


def shared_map(conn, token):
    return conn.execute(
        """
        SELECT m.name, m.is_public, m.updated_at, m.data_json, u.username AS author
        FROM maps m JOIN users u ON u.id = m.owner_id
        WHERE m.share_token = ?
        """,
        (token,),
    ).fetchone()


def notifications(conn, uid):
    return conn.execute(
        """
        SELECT c.id, c.text, c.created_at, c.map_id, m.name AS map_name, u.username AS author
        FROM comments c
        JOIN maps m ON m.id = c.map_id
        JOIN users u ON u.id = c.author_id
        WHERE m.owner_id = ?
        ORDER BY c.created_at DESC
        LIMIT 20
        """,
        (uid,),
    ).fetchall()
