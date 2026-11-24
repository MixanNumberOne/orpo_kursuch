from flask import Blueprint, jsonify, request, session

from security import auth_required
from services import gallery as gallery_service
from validation import body

gallery = Blueprint("gallery", __name__)


@gallery.get("/api/gallery")
def list_gallery():
    return jsonify(items=gallery_service.list_gallery(request.args.get("sort") == "old"))


@gallery.get("/api/gallery/<int:map_id>")
def gallery_map(map_id):
    return jsonify(gallery_service.gallery_map(map_id, session.get("user_id")))


@gallery.post("/api/gallery/<int:map_id>/comments")
@auth_required
def add_comment(map_id):
    return jsonify(gallery_service.add_comment(map_id, session["user_id"], body().get("text"))), 201


@gallery.delete("/api/comments/<int:comment_id>")
@auth_required
def delete_comment(comment_id):
    gallery_service.delete_comment(comment_id, session["user_id"])
    return jsonify(ok=True)


@gallery.get("/api/share/<token>")
def shared_map(token):
    return jsonify(gallery_service.shared_map(token))


@gallery.get("/api/notifications")
@auth_required
def notifications():
    return jsonify(items=gallery_service.notifications(session["user_id"]))
