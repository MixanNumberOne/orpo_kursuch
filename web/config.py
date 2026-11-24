import os
import re
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
JS_DIR = BASE_DIR / "js"
MAX_ASSET = int(os.environ.get("DUNGEON_MAX_ASSET", str(int(1.5 * 1024 * 1024))))
MAX_DOCUMENT = 5_000_000
USER_RE = re.compile(r"^[A-Za-zА-Яа-яЁё0-9_\-]{3,32}$")
UNSAFE = {"POST", "PUT", "PATCH", "DELETE"}
