from flask import Blueprint, jsonify, request, send_file, session

from security import auth_required
from services import assets as asset_service

assets = Blueprint("assets", __name__)


@assets.get("/api/assets")
@auth_required
def list_assets():
    return jsonify(items=asset_service.list_assets(session["user_id"]))


@assets.post("/api/assets")
@auth_required
def upload_asset():
    asset = asset_service.upload(session["user_id"], request.files.get("file"))
    return jsonify(asset=asset), 201


@assets.get("/api/assets/<asset_id>/file")
@auth_required
def asset_file(asset_id):
    path, mime = asset_service.file_for(session["user_id"], asset_id)
    return send_file(path, mimetype=mime, max_age=3600)


@assets.delete("/api/assets/<asset_id>")
@auth_required
def delete_asset(asset_id):
    asset_service.delete(session["user_id"], asset_id)
    return jsonify(ok=True)
