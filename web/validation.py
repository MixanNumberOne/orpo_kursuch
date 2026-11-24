import json

from flask import request

from config import MAX_DOCUMENT, USER_RE
from errors import ApiError


def body():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ApiError("Ожидался JSON-объект")
    return data


def clean_username(value):
    if not isinstance(value, str) or not USER_RE.fullmatch(value.strip()):
        raise ApiError("Имя: 3–32 символа, буквы, цифры, _ и -")
    return value.strip()


def clean_password(value):
    if not isinstance(value, str) or not (4 <= len(value) <= 128):
        raise ApiError("Пароль должен быть от 4 до 128 символов")
    return value


def clean_title(value, default="Новая карта", limit=80):
    if value is None:
        return default
    if not isinstance(value, str):
        raise ApiError("Некорректное название")
    name = value.strip() or default
    if len(name) > limit:
        raise ApiError("Слишком длинное название")
    return name


def required_name(value, limit=40):
    if not isinstance(value, str) or not value.strip():
        raise ApiError("Введите название")
    name = value.strip()
    if len(name) > limit:
        raise ApiError("Слишком длинное название")
    return name


def as_bool(value):
    if isinstance(value, bool):
        return value
    if value in (0, 1):
        return bool(value)
    raise ApiError("Некорректный признак публикации")


def clean_comment(value):
    if not isinstance(value, str):
        raise ApiError("Введите комментарий")
    text = value.strip()
    if not text:
        raise ApiError("Введите комментарий")
    if len(text) > 1000:
        raise ApiError("Комментарий длиннее 1000 символов")
    return text


def clean_preview(value):
    if not isinstance(value, str):
        return ""
    if not value.startswith("data:image/") or len(value) > 200_000:
        return ""
    return value


def valid_tile(tile):
    if isinstance(tile, bool) or not isinstance(tile, int):
        return False
    if tile in (0, 1, 2, 3) or 4 <= tile <= 9:
        return True
    if 100 <= tile <= 104 or 200 <= tile <= 204:
        return True
    return False


def validate_doc(data):
    if not isinstance(data, dict):
        return "Некорректный документ"
    cols, rows = data.get("cols"), data.get("rows")
    if isinstance(cols, bool) or isinstance(rows, bool) or not isinstance(cols, int) or not isinstance(rows, int):
        return "Некорректный размер карты"
    if not (8 <= cols <= 96 and 8 <= rows <= 64):
        return "Некорректный размер карты"
    layers = data.get("layers")
    if not isinstance(layers, list) or not (1 <= len(layers) <= 24):
        return "Нужен хотя бы один слой"
    need = cols * rows
    tiles_found = False
    for layer in layers:
        if not isinstance(layer, dict):
            return "Некорректный слой"
        kind = layer.get("kind")
        if kind == "tiles":
            tiles_found = True
            tiles = layer.get("tiles")
            if not isinstance(tiles, list) or len(tiles) != need:
                return "Слой тайлов не совпадает с размером карты"
            for tile in tiles:
                if not valid_tile(tile):
                    return "Некорректная клетка карты"
        elif kind in ("objects", "notes"):
            items = layer.get("items", [])
            if not isinstance(items, list) or len(items) > 400:
                return "Слишком много объектов на слое"
        else:
            return "Неизвестный тип слоя"
    if not tiles_found:
        return "Нужен слой тайлов"
    history = data.get("history")
    if history is not None:
        if not isinstance(history, dict):
            return "Некорректная история"
        for key in ("undo", "redo"):
            stack = history.get(key) or []
            if not isinstance(stack, list):
                return "Некорректная история"
            if len(stack) > 40:
                history[key] = stack[-40:]
    return None


def document_json(data):
    error = validate_doc(data)
    if error:
        raise ApiError(error)
    raw = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    if len(raw) > MAX_DOCUMENT:
        raise ApiError("Карта слишком большая")
    return raw


def sanitize_public(data):
    layers = []
    for layer in data.get("layers") or []:
        if not isinstance(layer, dict) or layer.get("kind") == "notes" or layer.get("visible") is False:
            continue
        public = {
            "id": layer.get("id"),
            "name": layer.get("name"),
            "kind": layer.get("kind"),
            "visible": True,
            "locked": True,
        }
        if layer.get("kind") == "tiles":
            public["tiles"] = layer.get("tiles") or []
        else:
            items = []
            for item in layer.get("items") or []:
                if isinstance(item, dict):
                    items.append({
                        "id": item.get("id"),
                        "kind": item.get("kind"),
                        "x": item.get("x"),
                        "y": item.get("y"),
                        "w": item.get("w"),
                        "h": item.get("h"),
                        "src": item.get("src") or "",
                        "text": item.get("text") or "",
                        "description": item.get("description") or "",
                        "color": item.get("color") or "#f3e6c0",
                        "name": item.get("name") or "",
                    })
            public["items"] = items
        layers.append(public)
    grid = data.get("grid") if isinstance(data.get("grid"), dict) else {}
    return {"cols": data.get("cols"), "rows": data.get("rows"), "grid": grid, "layers": layers}


def save_fields(data, current=None):
    name = clean_title(data.get("name"), default=current["name"] if current else "Новая карта")
    if "is_public" in data:
        is_public = as_bool(data.get("is_public"))
    else:
        is_public = bool(current["is_public"]) if current else False
    if "data" not in data:
        raise ApiError("Нет данных карты")
    raw = document_json(data.get("data"))
    preview = clean_preview(data.get("preview", ""))
    return name, is_public, raw, preview
