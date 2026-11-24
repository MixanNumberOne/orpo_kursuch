import sqlite3

from werkzeug.security import check_password_hash, generate_password_hash

from db import db, now
from errors import ApiError
from repositories import users
from validation import clean_password, clean_username


def current(uid):
    if not uid:
        return None
    with db() as conn:
        row = users.find(conn, uid)
    if row is None:
        return None
    return {"id": row["id"], "username": row["username"]}


def register(username, password):
    username = clean_username(username)
    password = clean_password(password)
    try:
        with db() as conn:
            uid = users.create(conn, username, generate_password_hash(password), now())
    except sqlite3.IntegrityError:
        raise ApiError("Такое имя уже занято", 409) from None
    return {"id": uid, "username": username}


def login(username, password):
    if not isinstance(username, str) or not isinstance(password, str):
        raise ApiError("Неверное имя или пароль", 401)
    with db() as conn:
        row = users.find_by_name(conn, username.strip())
    if row is None or not check_password_hash(row["password_hash"], password):
        raise ApiError("Неверное имя или пароль", 401)
    return {"id": row["id"], "username": row["username"]}
