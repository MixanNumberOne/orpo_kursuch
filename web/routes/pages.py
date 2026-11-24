import re

from flask import Blueprint, abort, render_template, send_from_directory, session

from config import JS_DIR

pages = Blueprint("pages", __name__)


@pages.get("/")
def index():
    return render_template("index.html", csrf=session.get("csrf", ""))


@pages.get("/s/<token>")
def shared_page(token):
    if not re.fullmatch(r"[A-Za-z0-9_\-]{8,80}", token):
        abort(404)
    return render_template("view.html", token=token)


@pages.get("/js/<path:filename>")
def scripts(filename):
    return send_from_directory(JS_DIR, filename)


@pages.get("/favicon.ico")
def favicon():
    return ("", 204)
