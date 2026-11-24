class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


def register_error_handlers(app):
    from flask import jsonify, request

    @app.errorhandler(ApiError)
    def handle_api_error(err):
        return jsonify(error=err.message), err.status

    @app.errorhandler(413)
    def handle_too_large(_err):
        return jsonify(error="Файл больше допустимого размера"), 413

    @app.errorhandler(404)
    def handle_404(err):
        if request.path.startswith("/api/"):
            return jsonify(error="Не найдено"), 404
        return err
