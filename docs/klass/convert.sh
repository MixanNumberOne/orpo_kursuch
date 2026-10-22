#!/bin/bash
set -e

if ! command -v mmdc &> /dev/null; then
    echo "❌ mmdc не найден."
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="${1:-.}"

CONFIG="$SCRIPT_DIR/mermaid-config.json"
PUPPETEER="$SCRIPT_DIR/puppeteer-config.json"
CSS="$SCRIPT_DIR/mermaid-fix.css" # <-- Добавили переменную

count=0
failed=0

while IFS= read -r -d '' file; do
    base="${file%.md}"
    target="${base}.png"
    generated="${base}-1.svg"

    echo "🔄 $file → $target"
    rm -f "$target" "$generated"

    # Добавили флаг -C "$CSS"
    if mmdc -i "$file" -o "$target" \
        -b white -s 3 \
        -c "$CONFIG" \
        -p "$PUPPETEER" \
        -C "$CSS"; then
        [[ -f "$generated" ]] && mv "$generated" "$target"
        echo "✅ $target"
        count=$((count + 1))
    else
        echo "❌ ошибка: $file"
        failed=$((failed + 1))
    fi
done < <(find "$DIR" -type f -name "*.md" -print0)

echo "✅ Успешно: $count   ❌ Ошибок: $failed"