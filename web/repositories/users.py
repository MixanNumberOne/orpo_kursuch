def find(conn, uid):
    return conn.execute("SELECT id, username FROM users WHERE id = ?", (uid,)).fetchone()


def find_by_name(conn, username):
    return conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()


def create(conn, username, password_hash, stamp):
    cur = conn.execute(
        "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
        (username, password_hash, stamp),
    )
    return cur.lastrowid
