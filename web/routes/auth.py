from flask import Blueprint, jsonify, session

from security import require_csrf
from services import auth as auth_service
from validation import body

auth = Blueprint("auth", __name__)


@auth.get("/api/auth/me")
def me():
    uid = session.get("user_id")
    user = auth_service.current(uid)
    if uid and user is None:
        session.pop("user_id", None)
    return jsonify(user=user)


@auth.post("/api/auth/register")
def register():
    require_csrf()
    data = body()
    user = auth_service.register(data.get("username"), data.get("password"))
    session["user_id"] = user["id"]
    session.permanent = True
    return jsonify(user=user), 201


@auth.post("/api/auth/login")
def login():
    require_csrf()
    data = body()
    user = auth_service.login(data.get("username"), data.get("password"))
    session["user_id"] = user["id"]
    session.permanent = True
    return jsonify(user=user)


@auth.post("/api/auth/logout")
def logout():
    require_csrf()
    session.pop("user_id", None)
    return jsonify(ok=True)
