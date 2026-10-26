import os
from flask import Flask, render_template, send_from_directory

# Получаем путь к папке, где лежит main.py
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app = Flask(
    __name__,
    template_folder=os.path.join(BASE_DIR, 'templates'),  # HTML-шаблоны
    static_folder=os.path.join(BASE_DIR, 'js'),            # JS-файлы
    static_url_path='/js'                                  # URL-префикс для статики
)

@app.route('/')
def index():
    return render_template('index.html')

if __name__ == '__main__':
    print("Сервер запущен! Откройте в браузере: http://127.0.0.1:5000")
    app.run(debug=True, port=5000)