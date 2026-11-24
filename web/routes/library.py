from flask import Blueprint, jsonify, request, session

from security import auth_required
from services import library
from validation import as_bool, body

library_routes = Blueprint("library", __name__)


@library_routes.get("/api/folders")
@auth_required
def list_folders():
    return jsonify(items=library.list_folders(session["user_id"]))


@library_routes.post("/api/folders")
@auth_required
def create_folder():
    folder_id, name = library.create_folder(session["user_id"], body().get("name"))
    return jsonify(id=folder_id, name=name), 201


@library_routes.put("/api/folders/<int:folder_id>")
@auth_required
def rename_folder(folder_id):
    name = library.rename_folder(session["user_id"], folder_id, body().get("name"))
    return jsonify(id=folder_id, name=name)


@library_routes.delete("/api/folders/<int:folder_id>")
@auth_required
def delete_folder(folder_id):
    library.delete_folder(session["user_id"], folder_id)
    return jsonify(ok=True)


@library_routes.get("/api/tags")
@auth_required
def list_tags():
    return jsonify(items=library.list_tags(session["user_id"]))


@library_routes.post("/api/tags")
@auth_required
def create_tag():
    tag_id, name = library.create_tag(session["user_id"], body().get("name"))
    return jsonify(id=tag_id, name=name), 201


@library_routes.delete("/api/tags/<int:tag_id>")
@auth_required
def delete_tag(tag_id):
    library.delete_tag(session["user_id"], tag_id)
    return jsonify(ok=True)


@library_routes.get("/api/maps")
@auth_required
def list_maps():
    items = library.list_maps(session["user_id"], request.args.get("folder", "all"), request.args.get("tag"))
    return jsonify(items=items)


@library_routes.post("/api/maps")
@auth_required
def create_map():
    return jsonify(library.create_map(session["user_id"], body())), 201


@library_routes.get("/api/maps/<int:map_id>")
@auth_required
def get_map(map_id):
    return jsonify(library.get_map(session["user_id"], map_id))


@library_routes.put("/api/maps/<int:map_id>")
@auth_required
def update_map(map_id):
    return jsonify(library.update_map(session["user_id"], map_id, body()))


@library_routes.delete("/api/maps/<int:map_id>")
@auth_required
def delete_map(map_id):
    library.delete_map(session["user_id"], map_id)
    return jsonify(ok=True)


@library_routes.post("/api/maps/<int:map_id>/duplicate")
@auth_required
def duplicate_map(map_id):
    return jsonify(library.duplicate_map(session["user_id"], map_id)), 201


@library_routes.post("/api/maps/<int:map_id>/share")
@auth_required
def set_share(map_id):
    return jsonify(library.set_share(session["user_id"], map_id, as_bool(body().get("is_public"))))
