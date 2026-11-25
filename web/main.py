import subprocess
import ssl
from datetime import timedelta

from flask import Flask

from config import BASE_DIR
from db import init_db, secret_key
from errors import register_error_handlers
from routes.assets import assets
from routes.auth import auth
from routes.gallery import gallery
from routes.library import library_routes
from routes.pages import pages
from security import register_security

app = Flask(
    __name__,
    template_folder=str(BASE_DIR / "templates"),
    static_folder=str(BASE_DIR / "static"),
    static_url_path="/static",
)
app.json.ensure_ascii = False
app.config.update(
    SECRET_KEY=secret_key(),
    MAX_CONTENT_LENGTH=8 * 1024 * 1024,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(days=14),
    TEMPLATES_AUTO_RELOAD=True,
)
register_security(app)
register_error_handlers(app)
app.register_blueprint(pages)
app.register_blueprint(auth)
app.register_blueprint(library_routes)
app.register_blueprint(assets)
app.register_blueprint(gallery)

init_db()


def ensure_tls():
    folder = BASE_DIR / "certs"
    cert = folder / "cert.pem"
    key = folder / "key.pem"
    if cert.is_file() and key.is_file():
        return cert, key
    folder.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "openssl", "req", "-x509", "-newkey", "rsa:2048",
            "-keyout", str(key), "-out", str(cert),
            "-days", "825", "-nodes",
            "-subj", "/CN=localhost",
            "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
        ],
        check=True,
        capture_output=True,
    )
    return cert, key


if __name__ == "__main__":
    cert, key = ensure_tls()
    app.config["SESSION_COOKIE_SECURE"] = True
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    print("Сервер запущен: https://127.0.0.1:5000")
    app.run(debug=True, host="0.0.0.0", port=5000, ssl_context=context)
