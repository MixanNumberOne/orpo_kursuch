import secrets
from functools import wraps

from flask import request, session

from config import UNSAFE
from db import db
from errors import ApiError


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


def register_security(app):
    @app.before_request
    def ensure_csrf():
        if "csrf" not in session:
            session["csrf"] = secrets.token_hex(16)

    @app.after_request
    def disable_asset_cache(response):
        if request.path.startswith("/js/") or request.path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-cache"
        return response

    return app
